import { randomUUID } from 'node:crypto';
import {
  type CanUseTool,
  createSdkMcpServer,
  type EffortLevel,
  type HookCallback,
  type HookCallbackMatcher,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk/core';
import { claudePermissionMode } from '../approval.ts';
import { AsyncQueue } from '../async-queue.ts';
import { lineDiff } from '../diff.ts';
import { findExecutable, harnessEnvironment, pathDisplay } from '../environment.ts';
import {
  type AgentTool,
  askPermission,
  BaseSession,
  type CommandOption,
  type ModelOption,
  runTool,
  type SessionOptions,
  type SessionSettings,
  type ToolSet,
} from '../session.ts';

export interface ClaudeSessionOptions extends SessionOptions {
  /** Default: `default`, which sends every tool that needs approval to `onPermission`. */
  permissionMode?: PermissionMode;
  /** Extra Agent SDK options, for example `{ strictMcpConfig: true }`. They override the adapter's defaults. */
  sdkOptions?: Partial<Options>;
}

const STDERR_LIMIT = 4096;
/** Built-in tools that only read. `access: 'read-only'` limits the session to these. */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);
/** Built-in tools that change a file, matched by a PreToolUse hook. */
const FILE_CHANGE_TOOLS = 'Edit|MultiEdit|Write|NotebookEdit';

export async function startClaudeSession(options: ClaudeSessionOptions): Promise<ClaudeSession> {
  const env = await harnessEnvironment({
    CLAUDE_AGENT_SDK_CLIENT_APP: options.clientName,
    ...options.env,
  });
  const executable = options.executablePath ?? (await findExecutable('claude', env));
  const session = new ClaudeSession(options, env, executable);
  try {
    await session.start();
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}

export class ClaudeSession extends BaseSession {
  readonly harness = 'claude';
  readonly id: string;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly query: Query;
  private finalMessage = '';
  /** Claude Code ignores an interrupt that arrives before it reads the user message. */
  private turnStarted = false;
  private stderr = '';
  private readonly showPath: (file: string) => string;
  private readonly appTools = new Map<string, AgentTool>();

  constructor(
    private readonly options: ClaudeSessionOptions,
    env: Record<string, string>,
    executable: string,
  ) {
    super();
    this.id = options.resume ?? randomUUID();
    this.showPath = pathDisplay(options.cwd);
    const { tools } = options;
    for (const appTool of tools?.tools ?? []) this.appTools.set(`mcp__${tools!.name}__${appTool.name}`, appTool);
    const readOnly = options.access === 'read-only';
    this.query = query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        env,
        pathToClaudeCodeExecutable: executable,
        model: options.model,
        ...(options.effort && { effort: options.effort as EffortLevel }),
        settings: { showThinkingSummaries: true },
        permissionMode: options.permissionMode ?? 'default',
        ...(readOnly && { tools: READ_ONLY_TOOLS, strictMcpConfig: true }),
        ...(tools && { mcpServers: { [tools.name]: this.toolServer(tools) } }),
        ...(options.instructions && {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: options.instructions },
        }),
        includePartialMessages: true,
        canUseTool: this.canUseTool,
        stderr: (data) => {
          this.stderr = (this.stderr + data).slice(-STDERR_LIMIT);
        },
        ...(options.resume ? { resume: options.resume } : { sessionId: this.id }),
        ...options.sdkOptions,
        ...(tools && options.sdkOptions?.mcpServers && {
          mcpServers: { ...options.sdkOptions.mcpServers, [tools.name]: this.toolServer(tools) },
        }),
        ...(options.beforeFileChange && {
          hooks: {
            ...options.sdkOptions?.hooks,
            PreToolUse: [...(options.sdkOptions?.hooks?.PreToolUse ?? []), this.fileChangeHook()],
          },
        }),
      },
    });
  }

  /** Runs `beforeFileChange` before a built-in tool changes a file. Claude Code waits for the hook. */
  private fileChangeHook(): HookCallbackMatcher {
    const hook: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const { file_path: file, notebook_path: notebook } = (input.tool_input ?? {}) as Record<string, unknown>;
      const path = typeof file === 'string' ? file : typeof notebook === 'string' ? notebook : undefined;
      if (path) {
        try {
          await this.options.beforeFileChange?.([this.showPath(path)]);
        } catch {
          // The change goes ahead.
        }
      }
      return {};
    };
    return { matcher: FILE_CHANGE_TOOLS, hooks: [hook] };
  }

  private toolServer(tools: ToolSet): McpServerConfig {
    return createSdkMcpServer({
      name: tools.name,
      instructions: tools.description,
      alwaysLoad: true,
      tools: tools.tools.map((appTool) =>
        tool(appTool.name, appTool.description, appTool.input, async (input) => {
          const signal = this.currentTurn?.controller.signal ?? AbortSignal.abort();
          const { text, isError } = await runTool(appTool, input, signal);
          return { content: [{ type: 'text', text }], isError };
        }),
      ),
    });
  }

  async start(): Promise<void> {
    const pump = this.pump();
    await Promise.race([
      this.query.initializationResult(),
      pump.then(() => {
        throw new Error(this.closeMessage('Claude Code exited during startup'));
      }),
    ]);
  }

  protected async startTurn(text: string): Promise<void> {
    this.finalMessage = '';
    this.turnStarted = false;
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  protected async interruptTurn(): Promise<void> {
    if (this.turnStarted) await this.query.interrupt().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.markClosed();
    this.input.end();
    this.query.close();
  }

  async models(): Promise<ModelOption[]> {
    const models = await this.query.supportedModels();
    return models.map((model, index) => ({
      id: model.value,
      name: model.displayName,
      description: model.description,
      efforts: model.supportsEffort ? (model.supportedEffortLevels ?? []) : [],
      isDefault: index === 0,
    }));
  }

  async commands(): Promise<CommandOption[]> {
    const commands = await this.query.supportedCommands();
    return commands.map(({ name, description, argumentHint }) => ({ name, description, ...(argumentHint && { argumentHint }) }));
  }

  async configure(settings: SessionSettings): Promise<void> {
    if (settings.model !== undefined) await this.query.setModel(settings.model ?? undefined);
    if (settings.effort !== undefined) await this.query.applyFlagSettings({ effortLevel: (settings.effort as EffortLevel) ?? null });
    if (settings.approval) await this.query.setPermissionMode(claudePermissionMode(settings.approval));
  }

  private async pump(): Promise<void> {
    let error: string | undefined;
    try {
      for await (const message of this.query) this.handle(message);
    } catch (thrown) {
      error = this.closeMessage(thrown instanceof Error ? thrown.message : String(thrown));
    }
    this.markClosed(error ?? (this.closed ? undefined : this.closeMessage('Claude Code exited')));
  }

  private closeMessage(reason: string): string {
    const detail = this.stderr.trim().split('\n').slice(-5).join('\n');
    return detail ? `${reason}:\n${detail}` : reason;
  }

  private handle(message: SDKMessage): void {
    const turn = this.currentTurn;
    if (turn && !this.turnStarted && isTurnStart(message)) {
      this.turnStarted = true;
      if (turn.interruptRequested) void this.query.interrupt().catch(() => undefined);
    }
    if ('parent_tool_use_id' in message && message.parent_tool_use_id !== null) return;
    switch (message.type) {
      case 'stream_event': {
        const { event } = message;
        if (event.type !== 'content_block_delta') break;
        if (event.delta.type === 'text_delta') this.emit({ type: 'text-delta', text: event.delta.text });
        else if (event.delta.type === 'thinking_delta') this.emit({ type: 'thinking-delta', text: event.delta.thinking });
        break;
      }
      case 'assistant':
        for (const block of message.message.content) {
          if (block.type === 'text') {
            this.finalMessage = block.text;
            this.emit({ type: 'message', text: block.text });
          } else if (block.type === 'thinking') {
            if (block.thinking) this.emit({ type: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            this.emit({ type: 'tool-start', id: block.id, ...this.toolSummary(block.name, block.input as Record<string, unknown>) });
          }
        }
        break;
      case 'user': {
        const { content } = message.message;
        if (typeof content === 'string') break;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.emit({
            type: 'tool-end',
            id: block.tool_use_id,
            ok: !block.is_error,
            output: toolResultText(block.content),
          });
        }
        break;
      }
      case 'result':
        this.finishTurn(message);
        break;
    }
  }

  private finishTurn(message: Extract<SDKMessage, { type: 'result' }>): void {
    const turn = this.currentTurn;
    if (!turn) return;
    if (turn.interruptRequested) {
      turn.finish({ status: 'interrupted', text: this.finalMessage });
    } else if (message.subtype === 'success' && !message.is_error) {
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = message.usage;
      turn.finish({
        status: 'completed',
        text: message.result,
        usage: {
          durationMs: message.duration_ms,
          inputTokens: input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0),
          outputTokens: output_tokens,
        },
      });
    } else {
      const error = message.subtype === 'success' ? message.result : message.errors.join('\n') || message.subtype;
      turn.finish({ status: 'failed', text: this.finalMessage, error });
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, { signal, suggestions }) => {
    if (this.appTools.has(toolName)) return { behavior: 'allow', updatedInput: input };
    const decision = await askPermission(this.options.onPermission, {
      tool: toolName,
      title: this.describeTool(toolName, input),
      detail: this.toolDetail(toolName, input),
      raw: input,
      signal,
    });
    const result: PermissionResult =
      decision === 'deny'
        ? { behavior: 'deny', message: 'The user denied this action.' }
        : {
            behavior: 'allow',
            updatedInput: input,
            ...(decision === 'allow-session' && suggestions && { updatedPermissions: suggestions }),
          };
    return result;
  };

  private toolSummary(name: string, input: Record<string, unknown>) {
    const filePath = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
    return {
      tool: name,
      title: this.describeTool(name, input),
      detail: this.appTools.has(name) ? undefined : this.toolDetail(name, input),
      ...(FILE_TOOLS.has(name) && typeof filePath === 'string' && { paths: [this.showPath(filePath)] }),
    };
  }

  private describeTool(name: string, input: unknown): string {
    const appTool = this.appTools.get(name);
    if (appTool) return appTool.title?.(input as never) ?? appTool.name;
    const fields = (input ?? {}) as Record<string, unknown>;
    if (typeof fields.file_path === 'string') return `${name} ${this.showPath(fields.file_path)}`;
    const subject = fields.command ?? fields.pattern ?? fields.url ?? fields.description;
    return typeof subject === 'string' ? `${name} ${subject}` : name;
  }

  private toolDetail(name: string, input: Record<string, unknown>): string | undefined {
    if (name === 'Bash' && typeof input.command === 'string') return input.command;
    if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      return lineDiff(input.old_string, input.new_string);
    }
    if (name === 'Write' && typeof input.content === 'string') {
      return input.content.split('\n').map((line) => `+${line}`).join('\n');
    }
    if (name === 'Read' || name === 'Glob' || name === 'Grep') return undefined;
    return JSON.stringify(input, null, 2);
  }
}

function isTurnStart(message: SDKMessage): boolean {
  return (
    (message.type === 'system' && message.subtype === 'init') ||
    message.type === 'stream_event' ||
    message.type === 'assistant' ||
    message.type === 'result'
  );
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return (content as unknown[])
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('');
}
