import { type ChildProcess, spawn } from 'node:child_process';
import { findExecutable, harnessEnvironment, pathDisplay } from '../../environment.ts';
import {
  askPermission,
  BaseSession,
  type PermissionDecision,
  type SessionOptions,
} from '../../session.ts';
import type {
  AgentMessageDelta,
  ApprovalDecision,
  ApprovalPolicy,
  CommandApprovalParams,
  ErrorNotification,
  FileChangeApprovalParams,
  ItemNotification,
  PermissionsApprovalParams,
  SandboxMode,
  ThreadItem,
  ThreadStartResponse,
  TurnNotification,
} from './protocol.ts';
import { RpcConnection, RpcError } from './rpc.ts';

export interface CodexSessionOptions extends SessionOptions {
  /** When Codex asks before it acts. Default: `on-request`. */
  approvalPolicy?: ApprovalPolicy;
  /** What commands can do without approval. Default: `workspace-write`. */
  sandbox?: SandboxMode;
}

const CLIENT_VERSION = '0.1.0';
const STDERR_LIMIT = 4096;
const CLOSE_GRACE_MS = 2000;

const DECISIONS: Record<PermissionDecision, ApprovalDecision> = {
  allow: 'accept',
  'allow-session': 'acceptForSession',
  deny: 'decline',
};

export async function startCodexSession(options: CodexSessionOptions): Promise<CodexSession> {
  const env = await harnessEnvironment(options.env);
  const executable = options.executablePath ?? (await findExecutable('codex', env));
  const child = spawn(executable, ['app-server'], {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session = new CodexSession(child, options);
  try {
    await session.start();
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}

export class CodexSession extends BaseSession {
  readonly harness = 'codex';
  private threadId = '';
  private readonly rpc: RpcConnection;
  private turnId: string | undefined;
  /** The server accepts `turn/interrupt` only after it sends `turn/started`. */
  private turnStarted = false;
  private finalMessage = '';
  private lastError: string | undefined;
  private readonly items = new Map<string, ThreadItem>();
  private stderr = '';
  private readonly exited: Promise<void>;
  private readonly showPath: (file: string) => string;

  constructor(
    private readonly child: ChildProcess,
    private readonly options: CodexSessionOptions,
  ) {
    super();
    this.showPath = pathDisplay(options.cwd);
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
    });
    this.exited = new Promise((resolve) => {
      child.on('error', (error) => {
        this.shutdown(`Could not start codex: ${error.message}`);
        resolve();
      });
      child.on('exit', (code, signal) => {
        this.shutdown(this.exitMessage(code, signal));
        resolve();
      });
    });
    this.rpc = new RpcConnection(child.stdout!, child.stdin!, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(method, params),
    });
  }

  get id(): string {
    return this.threadId;
  }

  async start(): Promise<void> {
    const name = this.options.clientName;
    await this.rpc.request('initialize', {
      clientInfo: { name, title: name, version: CLIENT_VERSION },
      capabilities: null,
    });
    this.rpc.notify('initialized');
    const settings = {
      cwd: this.options.cwd,
      model: this.options.model ?? null,
      approvalPolicy: this.options.approvalPolicy ?? 'on-request',
      sandbox: this.options.sandbox ?? 'workspace-write',
      developerInstructions: this.options.instructions ?? null,
    };
    const response = this.options.resume
      ? await this.rpc.request<ThreadStartResponse>('thread/resume', {
          threadId: this.options.resume,
          excludeTurns: true,
          ...settings,
        })
      : await this.rpc.request<ThreadStartResponse>('thread/start', settings);
    this.threadId = response.thread.id;
  }

  protected async startTurn(text: string): Promise<void> {
    this.turnId = undefined;
    this.turnStarted = false;
    this.finalMessage = '';
    this.lastError = undefined;
    this.items.clear();
    const response = await this.rpc.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    this.turnId ??= response.turn.id;
  }

  protected async interruptTurn(): Promise<void> {
    if (this.turnStarted) await this.requestInterrupt();
  }

  async close(): Promise<void> {
    this.shutdown();
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill(), CLOSE_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }

  private async requestInterrupt(): Promise<void> {
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    } catch {
      // The turn already ended.
    }
  }

  private shutdown(error?: string): void {
    this.rpc.close(new Error(error ?? 'Session closed'));
    this.markClosed(error);
  }

  private exitMessage(code: number | null, signal: NodeJS.Signals | null): string | undefined {
    if (code === 0 || (this.closed && signal)) return undefined;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    const detail = this.stderr.trim().split('\n').slice(-5).join('\n');
    return `codex app-server exited with ${reason}${detail ? `:\n${detail}` : ''}`;
  }

  private handleNotification(method: string, params: unknown): void {
    if ((params as { threadId?: string } | undefined)?.threadId !== this.threadId || !this.currentTurn) return;
    switch (method) {
      case 'item/agentMessage/delta':
        this.emit({ type: 'text-delta', text: (params as AgentMessageDelta).delta });
        break;
      case 'item/started':
        this.itemStarted((params as ItemNotification).item);
        break;
      case 'item/completed':
        this.itemCompleted((params as ItemNotification).item);
        break;
      case 'error': {
        const { error, willRetry } = params as ErrorNotification;
        if (!willRetry) this.lastError = error.message;
        break;
      }
      case 'turn/started':
        this.turnId ??= (params as TurnNotification).turn.id;
        this.turnStarted = true;
        if (this.currentTurn.interruptRequested) void this.requestInterrupt();
        break;
      case 'turn/completed':
        this.turnCompleted(params as TurnNotification);
        break;
    }
  }

  private itemStarted(item: ThreadItem): void {
    this.items.set(item.id, item);
    const title = this.describeItem(item);
    if (title) this.emit({ type: 'tool-start', id: item.id, tool: item.type, title });
  }

  private itemCompleted(item: ThreadItem): void {
    this.items.set(item.id, item);
    if (item.type === 'agentMessage' && 'text' in item) {
      this.finalMessage = item.text;
      this.emit({ type: 'message', text: item.text });
      return;
    }
    if (!this.describeItem(item)) return;
    const status = 'status' in item ? item.status : 'completed';
    let ok = status === 'completed';
    let output: string | undefined;
    if (item.type === 'commandExecution' && 'command' in item) {
      ok &&= item.exitCode === 0;
      output = item.aggregatedOutput ?? undefined;
    } else if (item.type === 'mcpToolCall' && 'error' in item) {
      output = item.error?.message;
    }
    this.emit({ type: 'tool-end', id: item.id, ok, output });
  }

  private turnCompleted({ turn }: TurnNotification): void {
    if (this.turnId && turn.id !== this.turnId) return;
    const status = turn.status === 'inProgress' ? 'failed' : turn.status;
    const error = turn.error?.message ?? (status === 'failed' ? this.lastError : undefined);
    this.currentTurn?.finish({ status, text: this.finalMessage, ...(error && { error }) });
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    const signal = this.currentTurn?.controller.signal ?? AbortSignal.abort();
    const ask = (tool: string, title: string, detail?: string) =>
      askPermission(this.options.onPermission, { tool, title, detail, raw: params, signal });

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const request = params as CommandApprovalParams;
        const detail = [request.command, request.reason && `Reason: ${request.reason}`]
          .filter(Boolean)
          .join('\n');
        const title = request.command ? `Run ${unwrapShell(request.command)}` : 'Run a command';
        const decision = await ask('command', title, detail);
        return { decision: DECISIONS[decision] };
      }
      case 'item/fileChange/requestApproval': {
        const request = params as FileChangeApprovalParams;
        const item = this.items.get(request.itemId);
        const changes = item && 'changes' in item ? item.changes : [];
        const paths = changes.map((change) => this.showPath(change.path)).join(', ');
        const detail = [request.reason, ...changes.map((change) => change.diff)].filter(Boolean).join('\n');
        const decision = await ask('fileChange', `Edit ${paths || 'files'}`, detail);
        return { decision: DECISIONS[decision] };
      }
      case 'item/permissions/requestApproval': {
        const request = params as PermissionsApprovalParams;
        const detail = [request.reason, JSON.stringify(request.permissions, null, 2)].filter(Boolean).join('\n');
        const decision = await ask('permissions', 'Grant extra permissions', detail);
        if (decision === 'deny') return { permissions: {}, scope: 'turn' };
        const { network, fileSystem } = request.permissions;
        return {
          permissions: { ...(network && { network }), ...(fileSystem && { fileSystem }) },
          scope: decision === 'allow-session' ? 'session' : 'turn',
        };
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      default:
        throw new RpcError(-32601, `agent-helenite does not support ${method}`);
    }
  }

  private describeItem(item: ThreadItem): string | undefined {
    switch (item.type) {
      case 'commandExecution':
        return 'command' in item ? unwrapShell(item.command) : 'command';
      case 'fileChange':
        return 'changes' in item
          ? `Edit ${item.changes.map((change) => this.showPath(change.path)).join(', ')}`
          : 'Edit files';
      case 'mcpToolCall':
        return 'server' in item ? `${item.server}.${item.tool}` : 'MCP tool';
      case 'webSearch':
        return 'query' in item && item.query ? `Search: ${item.query}` : 'Web search';
      default:
        return undefined;
    }
  }
}

/** Codex runs commands as `/bin/zsh -lc '<command>'`. Titles show the inner command. */
export function unwrapShell(command: string): string {
  const match = command.match(/^\S*\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/);
  return match?.[2] ?? command;
}
