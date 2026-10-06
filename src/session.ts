import type { z } from 'zod';
import type { ApprovalSetting } from './approval.ts';

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
  /** Reasoning effort, for example `low`, `medium` or `high`. `AgentSession.models` lists the levels of each model. */
  effort?: string;
  /** Instructions added to the harness's own system prompt. They apply to every turn of a new session. */
  instructions?: string;
  /** Session id from an earlier `AgentSession.id`. The agent continues that conversation. */
  resume?: string;
  /** Called when the agent wants to use a tool that needs approval. With no handler, the session denies the request. */
  onPermission?: PermissionHandler;
  /** Tools that run inside the app. The agent calls them like its built-in tools, without approval. */
  tools?: ToolSet;
  /**
   * `read-only`: the agent can read files and search, but it cannot change files or run commands
   * that change them. It can still change things through `tools`. Default: `workspace`.
   */
  access?: 'workspace' | 'read-only';
  /**
   * Called before the agent changes files with its own tools, with the paths that it will change. Paths inside
   * `cwd` are relative. Claude Code waits for the promise. Codex waits only when it asks for approval first;
   * otherwise the change can start before the promise settles. Errors are ignored.
   */
  beforeFileChange?: (paths: string[]) => Promise<void> | void;
}

export interface ToolSet {
  /** Namespace of the tools, for example `note`. Letters, digits and underscores. */
  name: string;
  description: string;
  tools: AgentTool[];
}

export interface AgentTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Letters, digits and underscores. */
  name: string;
  description: string;
  input: Shape;
  /** Short one-line summary for `tool-start` events. */
  title?(input: z.infer<z.ZodObject<Shape>>): string;
  run(input: z.infer<z.ZodObject<Shape>>, context: { signal: AbortSignal }): Promise<ToolOutput>;
}

export type ToolOutput = string | { text: string; isError?: boolean };

/** Returns the tool unchanged. It exists so TypeScript infers the input type of `run` from `input`. */
export function defineTool<Shape extends z.ZodRawShape>(tool: AgentTool<Shape>): AgentTool<Shape> {
  return tool;
}

/** Runs an app tool. A thrown error becomes an error result, so the agent can react to it. */
export async function runTool(tool: AgentTool, input: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
  try {
    const output = await tool.run(input as never, { signal });
    return typeof output === 'string' ? { text: output, isError: false } : { text: output.text, isError: output.isError ?? false };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

export interface SessionSettings {
  model?: string | null;
  effort?: string | null;
  approval?: ApprovalSetting;
}

export interface ModelOption {
  /** Value for `SessionOptions.model` and `AgentSession.configure`. */
  id: string;
  name: string;
  description: string;
  /** Effort levels that the model accepts. Empty when the model has no effort setting. */
  efforts: string[];
  defaultEffort?: string;
  isDefault: boolean;
}

export interface CommandOption {
  /** Name without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
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
  usage?: TurnUsage;
}

export interface TurnUsage {
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type AgentEvent =
  | { type: 'turn-start'; prompt: string }
  | { type: 'text-delta'; text: string }
  | { type: 'message'; text: string }
  /** Summary of the agent's reasoning, when the harness and model provide one. */
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool-start';
      id: string;
      tool: string;
      /** Short one-line summary. */
      title: string;
      /** A command, or a diff whose lines start with ' ', '-' or '+'. */
      detail?: string;
      /** Files that the tool reads or changes, relative to `cwd` when inside it. */
      paths?: string[];
    }
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
  /** The models that the harness offers to this user. */
  models(): Promise<ModelOption[]>;
  /** Slash commands that `send` accepts, for example `/review`. */
  commands(): Promise<CommandOption[]>;
  /** Changes settings for the next turns. Omitted fields stay as they are; `null` returns to the default. */
  configure(settings: SessionSettings): Promise<void>;
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
  abstract models(): Promise<ModelOption[]>;
  abstract commands(): Promise<CommandOption[]>;
  abstract configure(settings: SessionSettings): Promise<void>;

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
        console.error('obsidian-duet: event listener threw', error);
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
    const started = Date.now();
    this.active = turn;
    this.emit({ type: 'turn-start', prompt: message.text });
    this.startTurn(message.text, turn).catch((error: unknown) =>
      turn.finish({ status: 'failed', text: '', error: error instanceof Error ? error.message : String(error) }),
    );
    void turn.result.then((finished) => {
      const result: TurnResult = { ...finished, usage: { ...finished.usage, durationMs: Date.now() - started } };
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
