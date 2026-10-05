import { randomUUID } from 'node:crypto';
import {
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk/core';
import { AsyncQueue } from '../async-queue.ts';
import { lineDiff } from '../diff.ts';
import { findExecutable, harnessEnvironment, pathDisplay } from '../environment.ts';
import { askPermission, BaseSession, type SessionOptions } from '../session.ts';

export interface ClaudeSessionOptions extends SessionOptions {
  /** Default: `default`, which sends every tool that needs approval to `onPermission`. */
  permissionMode?: PermissionMode;
  /** Extra Agent SDK options, for example `{ strictMcpConfig: true }`. They override the adapter's defaults. */
  sdkOptions?: Partial<Options>;
}

const STDERR_LIMIT = 4096;

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

  constructor(
    private readonly options: ClaudeSessionOptions,
    env: Record<string, string>,
    executable: string,
  ) {
    super();
    this.id = options.resume ?? randomUUID();
    this.showPath = pathDisplay(options.cwd);
    this.query = query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        env,
        pathToClaudeCodeExecutable: executable,
        model: options.model,
        permissionMode: options.permissionMode ?? 'default',
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
      },
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
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          this.emit({ type: 'text-delta', text: event.delta.text });
        }
        break;
      }
      case 'assistant':
        for (const block of message.message.content) {
          if (block.type === 'text') {
            this.finalMessage = block.text;
            this.emit({ type: 'message', text: block.text });
          } else if (block.type === 'tool_use') {
            this.emit({ type: 'tool-start', id: block.id, tool: block.name, title: this.describeTool(block.name, block.input) });
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
      turn.finish({ status: 'completed', text: message.result });
    } else {
      const error = message.subtype === 'success' ? message.result : message.errors.join('\n') || message.subtype;
      turn.finish({ status: 'failed', text: this.finalMessage, error });
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, { signal, suggestions }) => {
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

  private describeTool(name: string, input: unknown): string {
    const fields = (input ?? {}) as Record<string, unknown>;
    if (typeof fields.file_path === 'string') return `${name} ${this.showPath(fields.file_path)}`;
    const subject = fields.command ?? fields.pattern ?? fields.url ?? fields.description;
    return typeof subject === 'string' ? `${name} ${subject}` : name;
  }

  private toolDetail(name: string, input: Record<string, unknown>): string {
    if (name === 'Bash' && typeof input.command === 'string') return input.command;
    if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      return lineDiff(input.old_string, input.new_string);
    }
    if (name === 'Write' && typeof input.content === 'string') {
      return input.content.split('\n').map((line) => `+${line}`).join('\n');
    }
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
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('');
}
