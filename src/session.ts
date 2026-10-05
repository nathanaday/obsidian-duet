export type Harness = 'claude' | 'codex';

export interface SessionOptions {
  /** Working directory of the agent. For the Obsidian plugin, this is the vault root. */
  cwd: string;
  /** Name of the app that drives the session. The harness uses it to identify the client. */
  clientName: string;
  /** Path to the harness binary. When omitted, `findExecutable` looks it up. */
  executablePath?: string;
  /** Variables added to the inherited environment, for example `CLAUDE_CONFIG_DIR`. */
  env?: Record<string, string>;
  model?: string;
  /** Instructions added to the harness's own system prompt. They apply to every turn of a new session. */
  instructions?: string;
  /** Session id from an earlier `AgentSession.id`. The agent continues that conversation. */
  resume?: string;
  /** Called when the agent wants to use a tool that needs approval. With no handler, the session denies the request. */
  onPermission?: PermissionHandler;
}

export interface PermissionRequest {
  /** Harness-specific tool name, for example `Bash`, `Edit`, `command` or `fileChange`. */
  tool: string;
  /** Short one-line summary, at most 100 characters. */
  title: string;
  /**
   * Content the user needs to see to decide: a command, or for a file change a diff whose lines
   * start with ' ', '-' or '+' (Codex diffs also contain '@@' hunk headers).
   */
  detail?: string;
  /** Raw request from the harness. */
  raw: unknown;
  /** Aborts when the harness no longer needs the answer, for example after an interrupt. */
  signal: AbortSignal;
}

/** `allow-session` approves this request and similar requests for the rest of the session. */
export type PermissionDecision = 'allow' | 'allow-session' | 'deny';

export type PermissionHandler = (request: PermissionRequest) => Promise<PermissionDecision>;

export type TurnStatus = 'completed' | 'interrupted' | 'failed';

export interface TurnResult {
  status: TurnStatus;
  /** The agent's final message for the turn. Empty when the turn did not finish. */
  text: string;
  error?: string;
}

export type AgentEvent =
  | { type: 'turn-start'; prompt: string }
  | { type: 'text-delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool-start'; id: string; tool: string; /** Short one-line summary. */ title: string }
  | { type: 'tool-end'; id: string; ok: boolean; output?: string }
  | { type: 'turn-end'; result: TurnResult }
  | { type: 'closed'; error?: string };

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentSession {
  readonly harness: Harness;
  /** Pass this value as `SessionOptions.resume` to continue the conversation later. */
  readonly id: string;
  readonly closed: boolean;
  /** Subscribes to session events. Returns a function that removes the listener. */
  on(listener: AgentEventListener): () => void;
  /**
   * Sends a user message and resolves when the agent finishes its turn.
   * Messages sent during a turn wait until the current turn ends.
   */
  send(text: string): Promise<TurnResult>;
  /** Stops the current turn. The turn resolves with status `interrupted`. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export class SessionClosedError extends Error {
  constructor(reason?: string) {
    super(reason ? `Session closed: ${reason}` : 'Session closed');
    this.name = 'SessionClosedError';
  }
}

interface QueuedMessage {
  text: string;
  resolve(result: TurnResult): void;
  reject(error: Error): void;
}

/**
 * Shared turn queue and event delivery. A turn becomes active inside `send`,
 * so `interrupt` right after `send` stops that turn.
 */
export abstract class BaseSession implements AgentSession {
  abstract readonly harness: Harness;
  abstract readonly id: string;

  private readonly listeners = new Set<AgentEventListener>();
  private readonly queue: QueuedMessage[] = [];
  private active: ActiveTurn | undefined;
  private closeReason: string | undefined;
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed;
  }

  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(text: string): Promise<TurnResult> {
    if (this.isClosed) return Promise.reject(new SessionClosedError(this.closeReason));
    return new Promise((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      if (!this.active) this.startNext();
    });
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn || turn.interruptRequested) return;
    turn.interruptRequested = true;
    turn.controller.abort();
    await this.interruptTurn(turn);
  }

  abstract close(): Promise<void>;

  /** Sends the message to the harness. The adapter calls `turn.finish` when the harness ends the turn. */
  protected abstract startTurn(text: string, turn: ActiveTurn): Promise<void>;

  protected abstract interruptTurn(turn: ActiveTurn): Promise<void>;

  protected get currentTurn(): ActiveTurn | undefined {
    return this.active;
  }

  protected emit(event: AgentEvent): void {
    if (event.type === 'tool-start') event = { ...event, title: oneLine(event.title) };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('agent-helenite: event listener threw', error);
      }
    }
  }

  /** Closes the session once: ends the active turn, rejects queued messages and emits `closed`. */
  protected markClosed(error?: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeReason = error;
    this.active?.finish({ status: error ? 'failed' : 'interrupted', text: '', error: error ?? 'Session closed' });
    this.rejectQueued();
    this.emit({ type: 'closed', error });
  }

  private startNext(): void {
    const message = this.queue.shift();
    if (!message) return;
    const turn = new ActiveTurn();
    this.active = turn;
    this.emit({ type: 'turn-start', prompt: message.text });
    this.startTurn(message.text, turn).catch((error: unknown) =>
      turn.finish({ status: 'failed', text: '', error: error instanceof Error ? error.message : String(error) }),
    );
    void turn.result.then((result) => {
      this.active = undefined;
      this.emit({ type: 'turn-end', result });
      message.resolve(result);
      if (this.isClosed) this.rejectQueued();
      else this.startNext();
    });
  }

  private rejectQueued(): void {
    for (const message of this.queue.splice(0)) message.reject(new SessionClosedError(this.closeReason));
  }
}

export class ActiveTurn {
  /** Aborts on interrupt and when the turn ends, so open permission prompts can close. */
  readonly controller = new AbortController();
  readonly result: Promise<TurnResult>;
  interruptRequested = false;
  private resolve!: (result: TurnResult) => void;

  constructor() {
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  finish(result: TurnResult): void {
    this.controller.abort();
    this.resolve(result);
  }
}

/** Shortens text to one line of at most `max` characters. */
export function oneLine(text: string, max = 100): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export async function askPermission(
  handler: PermissionHandler | undefined,
  request: PermissionRequest,
): Promise<PermissionDecision> {
  if (!handler) return 'deny';
  try {
    return await handler({ ...request, title: oneLine(request.title) });
  } catch {
    return 'deny';
  }
}
