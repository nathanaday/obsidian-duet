import { type App, FileSystemAdapter, Notice, type TFile } from 'obsidian';
import { type AgentEvent, type AgentSession, approvalOptions, createSession, type CreateSessionOptions } from '../../src/index.ts';
import { newMarker, renderCallout, type ReplyState } from './callout.ts';
import { CalloutWriter } from './note-writer.ts';
import type { PermissionPrompts } from './permission-modal.ts';
import { type AgentProfile, displayName, parseEnv } from './settings.ts';

const INSTRUCTIONS = `You are running inside Obsidian, the note-taking app, through the Helenite plugin. Your working directory is the root of the user's vault.

The user calls you by writing @ and your name, followed by a request, on a line of a note. Each message starts with the note's path and the line number. Your final message goes into that note as a callout directly below the line.

- Write Markdown that reads well inside the note. Obsidian links like [[Note name]] work.
- Answer directly. Leave out preambles, sign-offs and offers of more help.
- Keep the reply short unless the user asks for more.
- Read or change files in the vault when the request needs it. Do not edit the callout that will hold your reply; it starts with "> [!agent]".
- Wait for commands to finish before you reply. Do not run work in the background: the note shows only your reply to each mention.`;

/** Session ids by note path, then by agent name. The plugin saves this map with its settings. */
export type SessionIndex = Record<string, Record<string, string>>;

export interface Mention {
  file: TFile;
  line: number;
  prompt: string;
  profile: AgentProfile;
  marker: string;
}

interface Reply {
  writer: CalloutWriter;
  title: string;
  /** Text of the message that is streaming now. */
  streaming: string;
  /** The last complete message. */
  message: string;
  activity: string | undefined;
}

class LiveSession {
  readonly replies: Reply[] = [];
  current: Reply | undefined;
  idleTimer: number | undefined;

  constructor(
    readonly session: AgentSession,
    readonly profile: AgentProfile,
    readonly file: TFile,
  ) {}

  get busy(): boolean {
    return this.current !== undefined || this.replies.length > 0;
  }
}

/** Keys are the agent name and the note path, joined by a NUL character. */
export class AgentManager {
  private readonly live = new Map<string, Promise<LiveSession>>();
  private readonly settled = new Map<string, LiveSession>();

  constructor(
    private readonly app: App,
    private readonly sessions: SessionIndex,
    private readonly prompts: PermissionPrompts,
    private readonly options: {
      idleMinutes: () => number;
      save: () => Promise<void>;
      onActivity: () => void;
    },
  ) {}

  /** Number of agents that are working now. */
  get working(): number {
    let count = 0;
    for (const live of this.settled.values()) if (live.busy) count++;
    return count;
  }

  async ask(mention: Mention): Promise<void> {
    const { file, profile, marker } = mention;
    const reply: Reply = {
      writer: new CalloutWriter(this.app, file, marker),
      title: displayName(profile),
      streaming: '',
      message: '',
      activity: undefined,
    };
    let live: LiveSession;
    try {
      live = await this.liveSession(file, profile);
    } catch (error) {
      reply.writer.update(renderCallout(reply.title, { kind: 'failed', text: '', error: (error as Error).message }, marker));
      await reply.writer.flush();
      new Notice(`@${profile.name} could not start: ${(error as Error).message}`);
      return;
    }
    window.clearTimeout(live.idleTimer);
    live.replies.push(reply);
    this.options.onActivity();
    const prompt = `Note: ${file.path} (line ${mention.line + 1})\n\n${mention.prompt}`;
    await live.session.send(prompt).catch(async (error: Error) => {
      // The session closed before this turn started. The 'closed' handler may already have failed the reply.
      const index = live.replies.indexOf(reply);
      if (index < 0) return;
      live.replies.splice(index, 1);
      this.render(reply, { kind: 'failed', text: '', error: error.message });
      await reply.writer.flush();
    });
  }

  /** Stops the agents that are working in a note. */
  async interrupt(file: TFile): Promise<number> {
    let stopped = 0;
    for (const [key, live] of this.settled) {
      if (key.endsWith(`\u0000${file.path}`) && live.current) {
        stopped++;
        await live.session.interrupt();
      }
    }
    return stopped;
  }

  /** Ends the conversations in a note. The next mention starts new ones. */
  async forget(file: TFile): Promise<void> {
    for (const key of [...this.live.keys()]) {
      if (key.endsWith(`\u0000${file.path}`)) await this.closeKey(key);
    }
    delete this.sessions[file.path];
    await this.options.save();
  }

  /** Moves stored and live sessions to a note's new path. */
  async rename(file: TFile, oldPath: string): Promise<void> {
    if (this.sessions[oldPath]) {
      this.sessions[file.path] = this.sessions[oldPath]!;
      delete this.sessions[oldPath];
      await this.options.save();
    }
    for (const [key, live] of [...this.live]) {
      const [name, path] = key.split('\u0000');
      if (path !== oldPath) continue;
      this.live.delete(key);
      this.live.set(`${name}\u0000${file.path}`, live);
      const settled = this.settled.get(key);
      if (settled) {
        this.settled.delete(key);
        this.settled.set(`${name}\u0000${file.path}`, settled);
      }
    }
  }

  /** Closes agents that are not working, so they restart with new settings. */
  async closeIdle(): Promise<void> {
    for (const [key, live] of [...this.settled]) if (!live.busy) await this.closeKey(key);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((key) => this.closeKey(key)));
  }

  private async closeKey(key: string): Promise<void> {
    const pending = this.live.get(key);
    this.live.delete(key);
    this.settled.delete(key);
    const live = await pending?.catch(() => undefined);
    if (!live) return;
    window.clearTimeout(live.idleTimer);
    await live.session.close();
  }

  private liveSession(file: TFile, profile: AgentProfile): Promise<LiveSession> {
    const key = `${profile.name}\u0000${file.path}`;
    const existing = this.live.get(key);
    if (existing) return existing;
    const starting = this.start(file, profile, key);
    this.live.set(key, starting);
    starting.then(
      (live) => this.settled.set(key, live),
      () => this.live.delete(key),
    );
    return starting;
  }

  private async start(file: TFile, profile: AgentProfile, key: string): Promise<LiveSession> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('Helenite needs a vault on the local file system.');
    const stored = this.sessions[file.path]?.[profile.name];
    const options = (resume?: string): CreateSessionOptions =>
      ({
        harness: profile.harness,
        cwd: adapter.getBasePath(),
        clientName: 'obsidian-helenite',
        executablePath: profile.executablePath || undefined,
        env: {
          ...(profile.harness === 'claude' && { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }),
          ...parseEnv(profile.env),
        },
        model: profile.model || undefined,
        instructions: INSTRUCTIONS,
        resume,
        onPermission: (request) => this.prompts.ask(request, { agent: displayName(profile), notePath: file.path }),
        ...approvalOptions(profile.harness, profile.approval),
        ...(profile.harness === 'claude' && { sdkOptions: { strictMcpConfig: !profile.userTools } }),
      }) as CreateSessionOptions;

    let session: AgentSession;
    try {
      session = await createSession(options(stored));
    } catch (error) {
      if (!stored) throw error;
      // The stored conversation is gone, for example after the harness cleaned up old sessions.
      session = await createSession(options());
    }
    (this.sessions[file.path] ??= {})[profile.name] = session.id;
    await this.options.save();

    const live = new LiveSession(session, profile, file);
    session.on((event) => this.handle(live, event));
    session.on((event) => {
      if (event.type === 'closed' && this.settled.get(key) === live) {
        this.live.delete(key);
        this.settled.delete(key);
      }
    });
    return live;
  }

  private handle(live: LiveSession, event: AgentEvent): void {
    const reply = live.current;
    switch (event.type) {
      case 'turn-start':
        live.current = live.replies.shift();
        if (live.current) this.render(live.current, { kind: 'working', text: '' });
        else void this.followUp(live);
        break;
      case 'text-delta':
        if (!reply) break;
        reply.streaming += event.text;
        this.render(reply, { kind: 'working', text: reply.streaming, activity: reply.activity });
        break;
      case 'message':
        if (!reply) break;
        reply.message = event.text;
        reply.streaming = '';
        this.render(reply, { kind: 'working', text: reply.message, activity: reply.activity });
        break;
      case 'tool-start':
        if (!reply) break;
        reply.activity = event.title;
        this.render(reply, { kind: 'working', text: reply.streaming || reply.message, activity: reply.activity });
        break;
      case 'tool-end':
        if (!reply) break;
        reply.activity = undefined;
        this.render(reply, { kind: 'working', text: reply.streaming || reply.message });
        break;
      case 'turn-end': {
        live.current = undefined;
        if (reply) {
          const { status, text, error } = event.result;
          const partial = reply.streaming || reply.message;
          const state: ReplyState =
            status === 'completed'
              ? { kind: 'completed', text }
              : status === 'interrupted'
                ? { kind: 'stopped', text: partial }
                : { kind: 'failed', text: partial, error: error ?? 'The agent stopped with an error.' };
          this.render(reply, state);
          void reply.writer.flush();
        }
        if (!live.busy) {
          live.idleTimer = window.setTimeout(() => {
            for (const [key, candidate] of this.settled) if (candidate === live) void this.closeKey(key);
          }, this.options.idleMinutes() * 60_000);
        }
        this.options.onActivity();
        break;
      }
      case 'closed':
        live.current = undefined;
        for (const waiting of live.replies.splice(0)) {
          this.render(waiting, { kind: 'failed', text: '', error: event.error ?? 'The agent closed.' });
          void waiting.writer.flush();
        }
        this.options.onActivity();
        break;
    }
  }

  /** The agent started a turn on its own, for example after a background task. Its reply goes to the end of the note. */
  private async followUp(live: LiveSession): Promise<void> {
    const title = `${displayName(live.profile)} (follow-up)`;
    const marker = newMarker();
    const writer = await CalloutWriter.append(this.app, live.file, marker, renderCallout(title, { kind: 'working', text: '' }, marker));
    const reply: Reply = { writer, title, streaming: '', message: '', activity: undefined };
    if (live.current === undefined && live.session.closed === false) live.current = reply;
    this.options.onActivity();
  }

  private render(reply: Reply, state: ReplyState): void {
    reply.writer.update(renderCallout(reply.title, state, reply.writer.marker));
  }
}
