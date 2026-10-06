import { type App, Notice, normalizePath, type TFile } from 'obsidian';
import type {
  AgentEvent,
  AgentSession,
  ApprovalSetting,
  CommandOption,
  ModelOption,
  PermissionDecision,
  PermissionRequest,
} from '../../../src/index.ts';
import { activity, Presence, startAgent } from '../agent-session.ts';
import type { CollabHub } from '../collab/hub.ts';
import { LiveRegion } from '../collab/region.ts';
import { LOCAL_ORIGIN, type SharedNote } from '../collab/shared-note.ts';
import type { PermissionPrompts } from '../permission-modal.ts';
import { type AgentProfile, displayName } from '../settings.ts';
import { frontmatterEdit, renderTurn, titleFrom, userBlock } from './format.ts';
import { TurnTranscript } from './transcript.ts';

const INSTRUCTIONS = `You are running inside Obsidian, the note-taking app, through the Duet plugin. Your working directory is the root of the user's vault.

This conversation happens in a note, the conversation note. The plugin writes the user's messages and your replies into it as the conversation goes, so the note is the record of the conversation. Messages give its path.

What you can change:
- You can create, edit and delete any file in the vault with your own tools, such as your file-editing tools and the shell, when the user asks. This includes every note except the conversation note. The user's approval settings decide when you must ask first.
- The user sees your edits live in notes that are open, and may type in them at the same time.
- Do not edit the conversation note. The plugin writes your replies into it, and an edit there would collide with your reply. To show the user something, put it in your reply.

How to answer:
- Write Markdown that reads well in Obsidian. Link notes as [[Note name]].
- When the user links notes with [[...]], the message lists their paths. Read them when the request needs them.
- Wait for commands to finish before you reply. Do not run work in the background.`;

export interface PendingApproval {
  request: PermissionRequest;
  decide(decision: PermissionDecision): void;
}

export interface LocalCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export const LOCAL_COMMANDS: LocalCommand[] = [
  { name: 'model', description: 'Choose the model', argumentHint: '<model>' },
  { name: 'effort', description: 'Choose how much the model reasons', argumentHint: '<level>' },
  { name: 'mode', description: 'Choose when the agent asks before it acts', argumentHint: 'ask | edits | plan' },
  { name: 'new', description: 'Start a new conversation note' },
  { name: 'end', description: 'End this conversation and keep the note as a record' },
];

const MODES: Record<string, ApprovalSetting> = { ask: 'ask', edits: 'accept-edits', plan: 'plan', sandbox: 'sandbox' };

interface Turn {
  transcript: TurnTranscript;
  region: LiveRegion;
  stopWriting: () => void;
  /** Files that the agent's tools may be changing now. */
  writing: Map<string, number>;
}

/**
 * Runs one conversation note: its agent session, the transcript in the note, queued messages and
 * approval requests. Composers show its state and send through it.
 */
export class ConversationController {
  phase: 'idle' | 'starting' | 'working' = 'idle';
  models: ModelOption[] = [];
  commands: CommandOption[] = [];
  readonly approvals: PendingApproval[] = [];
  readonly queue: string[] = [];
  status: string | undefined;
  private session: AgentSession | undefined;
  private starting: Promise<AgentSession> | undefined;
  private note: SharedNote | undefined;
  private turn: Turn | undefined;
  private readonly presence: Presence;
  private readonly listeners = new Set<() => void>();
  private readonly holders = new Set<object>();
  private idleTimer: number | undefined;
  /** The path of the conversation note that the agent was last told. */
  private toldPath: string | undefined;
  /** Properties written to the note that the metadata cache may not show yet. */
  private readonly written: Record<string, string | undefined> = {};

  constructor(
    private readonly app: App,
    private readonly hub: CollabHub,
    readonly file: TFile,
    private readonly profiles: () => AgentProfile[],
    private readonly prompts: PermissionPrompts,
    private readonly options: {
      animate: () => boolean;
      idleMinutes: () => number;
      newConversation: (profile: AgentProfile) => void;
      onActivity: () => void;
    },
  ) {
    this.presence = new Presence(this.profile, options.animate);
  }

  get properties(): Record<string, unknown> {
    return { ...this.app.metadataCache.getFileCache(this.file)?.frontmatter, ...this.written };
  }

  /** A text property of the note. Undefined when it is missing or not text. */
  private property(key: string): string | undefined {
    const value = this.properties[key];
    return typeof value === 'string' ? value : undefined;
  }

  get profile(): AgentProfile {
    const name = this.property('agent')?.toLowerCase();
    const profiles = this.profiles();
    return profiles.find((profile) => profile.name.toLowerCase() === name) ?? profiles[0]!;
  }

  get agentName(): string {
    return displayName(this.profile);
  }

  get ended(): boolean {
    return this.properties.status === 'ended';
  }

  get model(): string | undefined {
    return this.property('model') || this.profile.model || undefined;
  }

  get effort(): string | undefined {
    return this.property('effort') || this.profile.effort || undefined;
  }

  get approval(): ApprovalSetting {
    return (this.property('approval') as ApprovalSetting | undefined) ?? this.profile.approval;
  }

  get working(): boolean {
    return this.phase !== 'idle';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A composer shows the conversation. While one does, the note stays shared and the agent warm. */
  async attach(holder: object): Promise<void> {
    this.holders.add(holder);
    window.clearTimeout(this.idleTimer);
    this.note ??= await this.hub.acquire(this.file, this);
    if (!this.ended) void this.ensureSession().catch(() => undefined);
  }

  detach(holder: object): void {
    this.holders.delete(holder);
    if (this.holders.size || this.working) return;
    this.releaseNote();
    this.scheduleIdle();
  }

  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    if (message.startsWith('/') && (await this.runLocal(message))) return;
    if (this.working) {
      this.queue.push(message);
      this.changed();
      return;
    }
    await this.run(message);
  }

  async interrupt(): Promise<void> {
    this.queue.length = 0;
    await this.session?.interrupt();
    this.changed();
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.setProperty('model', model);
    await this.session?.configure({ model: model ?? null });
    const efforts = this.models.find((option) => option.id === model)?.efforts ?? [];
    if (this.effort && efforts.length && !efforts.includes(this.effort)) await this.setEffort(undefined);
    this.changed();
  }

  async setEffort(effort: string | undefined): Promise<void> {
    await this.setProperty('effort', effort);
    await this.session?.configure({ effort: effort ?? null });
    this.changed();
  }

  async setApproval(approval: ApprovalSetting): Promise<void> {
    await this.setProperty('approval', approval === this.profile.approval ? undefined : approval);
    await this.session?.configure({ approval });
    this.changed();
  }

  /** Ends the conversation. The note stays as a record. */
  async end(): Promise<void> {
    if (this.working) await this.interrupt();
    await this.setProperty('status', 'ended');
    await this.closeSession();
    this.changed();
  }

  async resume(): Promise<void> {
    await this.setProperty('status', 'active');
    this.changed();
    void this.ensureSession().catch(() => undefined);
  }

  /** Efforts of the current model, or of the default model. */
  get efforts(): string[] {
    const model = this.models.find((option) => option.id === this.model) ?? this.models.find((option) => option.isDefault);
    return model?.efforts ?? [];
  }

  async destroy(): Promise<void> {
    window.clearTimeout(this.idleTimer);
    for (const approval of this.approvals.splice(0)) approval.decide('deny');
    await this.closeSession();
    this.releaseNote();
  }

  private async run(message: string): Promise<void> {
    this.phase = 'starting';
    this.status = 'Starting';
    this.changed();
    let session: AgentSession;
    try {
      session = await this.ensureSession();
    } catch (error) {
      this.phase = 'idle';
      this.status = undefined;
      new Notice(`${this.agentName} could not start: ${(error as Error).message}`);
      this.changed();
      return;
    }
    const note = (this.note ??= await this.hub.acquire(this.file, this));
    // Name a new conversation first, so the agent learns the note's final path.
    if (!/\n> \[!user\]/.test(note.content)) await this.rename(message).catch(() => undefined);
    this.appendLocal(note, `${userBlock(message)}\n\n\n`);
    this.beginTurn(note);
    this.phase = 'working';
    this.status = 'Thinking';
    this.changed();
    await session.send(this.prompt(message)).catch(() => undefined);
  }

  private beginTurn(note: SharedNote): void {
    const peer = this.presence.peer(note);
    peer.beginTurn();
    // The turn goes before the note's last line break, so text the user types at the very end stays out of it.
    const at = note.content.length - 1;
    const writing = new Map<string, number>();
    this.turn = {
      transcript: new TurnTranscript(),
      region: new LiveRegion(peer, at, at),
      writing,
      stopWriting: this.hub.addWriter({
        writes: (path) => writing.has(path),
        peer: (target) => this.presence.peer(target),
      }),
    };
    peer.setCursor(note.relative(at, -1));
  }

  private handle(event: AgentEvent): void {
    const status = activity(event);
    if (status) {
      this.status = status;
      this.presence.setStatus(status);
    }
    if (event.type === 'turn-start' && !this.turn && this.note) {
      // A turn that the agent started on its own.
      this.appendLocal(this.note, '\n');
      this.beginTurn(this.note);
      this.phase = 'working';
    }
    const turn = this.turn;
    if (turn) {
      turn.transcript.apply(event);
      if (event.type === 'tool-start') for (const path of event.paths ?? []) turn.writing.set(path, (turn.writing.get(path) ?? 0) + 1);
      if (event.type === 'tool-end') {
        // Disk changes from a tool can arrive just after it ends.
        window.setTimeout(() => {
          for (const [path, count] of turn.writing) count <= 1 ? turn.writing.delete(path) : turn.writing.set(path, count - 1);
        }, 1500);
      }
      turn.region.set(this.turnText(turn));
      if (event.type === 'turn-end') void this.finishTurn(turn);
    }
    if (event.type === 'closed') {
      this.session = undefined;
      this.starting = undefined;
      this.toldPath = undefined;
      if (this.turn) void this.finishTurn(this.turn);
    }
    this.changed();
  }

  private turnText(turn: Turn): string {
    const text = renderTurn(turn.transcript);
    return text ? `${text}\n` : '';
  }

  private async finishTurn(turn: Turn): Promise<void> {
    if (this.turn !== turn) return;
    this.turn = undefined;
    turn.region.set(this.turnText(turn));
    await turn.region.settled();
    turn.region.close();
    turn.stopWriting();
    this.presence.setStatus(undefined);
    this.status = undefined;
    this.phase = 'idle';
    window.setTimeout(() => {
      if (!this.working) this.presence.clear();
    }, 1200);
    this.changed();
    this.options.onActivity();
    const next = this.queue.shift();
    if (next) await this.run(next);
    else if (!this.holders.size) {
      this.releaseNote();
      this.scheduleIdle();
    }
  }

  private releaseNote(): void {
    if (this.note) this.hub.release(this.note, this);
    this.note = undefined;
  }

  private prompt(message: string): string {
    const linked = new Set<string>();
    for (const match of message.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const file = this.app.metadataCache.getFirstLinkpathDest(match[1]!.trim(), this.file.path);
      if (file) linked.add(file.path);
    }
    const context = [
      ...(this.toldPath !== this.file.path ? [`Conversation note: ${this.file.path} (do not edit it)`] : []),
      ...(linked.size ? [`Linked notes: ${[...linked].join(', ')}`] : []),
    ];
    this.toldPath = this.file.path;
    return context.length ? `${message}\n\n${context.join('\n')}` : message;
  }

  private ensureSession(): Promise<AgentSession> {
    if (this.session && !this.session.closed) return Promise.resolve(this.session);
    this.starting ??= startAgent(this.app, {
      profile: this.profile,
      instructions: INSTRUCTIONS,
      access: 'workspace',
      resume: this.property('session'),
      model: this.property('model'),
      effort: this.property('effort'),
      approval: this.approval,
      onPermission: (request) => this.ask(request),
    })
      .then(async (session) => {
        this.session = session;
        session.on((event) => this.handle(event));
        if (this.properties.session !== session.id) await this.setProperty('session', session.id);
        void Promise.all([session.models(), session.commands()])
          .then(([models, commands]) => {
            this.models = models;
            this.commands = commands;
            this.changed();
          })
          .catch(() => undefined);
        return session;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  private async closeSession(): Promise<void> {
    const session = this.session ?? (await this.starting?.catch(() => undefined));
    this.session = undefined;
    // A resumed session hears the path again; the note can be renamed while it is closed.
    this.toldPath = undefined;
    this.presence.clear();
    await session?.close();
  }

  private scheduleIdle(): void {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (!this.working && !this.holders.size) void this.closeSession();
    }, this.options.idleMinutes() * 60_000);
  }

  /** Shows an approval request in the composer, or in a dialog when no composer is open. */
  private ask(request: PermissionRequest): Promise<PermissionDecision> {
    if (!this.holders.size) return this.prompts.ask(request, { agent: this.agentName, notePath: this.file.path });
    return new Promise((resolve) => {
      const approval: PendingApproval = {
        request,
        decide: (decision) => {
          const index = this.approvals.indexOf(approval);
          if (index < 0) return;
          this.approvals.splice(index, 1);
          resolve(decision);
          this.changed();
        },
      };
      request.signal.addEventListener('abort', () => approval.decide('deny'));
      this.approvals.push(approval);
      this.changed();
    });
  }

  private async runLocal(message: string): Promise<boolean> {
    const [, name, argument = ''] = message.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
    const value = argument.trim();
    switch (name) {
      case 'model': {
        const model = this.models.find((option) => [option.id, option.name].some((candidate) => candidate.toLowerCase() === value.toLowerCase()));
        if (!model) new Notice(value ? `No model named ${value}.` : 'Write /model and a model name, or pick one from the model menu.');
        else await this.setModel(model.isDefault ? undefined : model.id);
        return true;
      }
      case 'effort':
        if (!this.efforts.includes(value.toLowerCase())) new Notice(`Effort levels: ${this.efforts.join(', ') || 'none for this model'}.`);
        else await this.setEffort(value.toLowerCase());
        return true;
      case 'mode':
        if (!MODES[value.toLowerCase()]) new Notice('Modes: ask, edits, plan.');
        else await this.setApproval(MODES[value.toLowerCase()]!);
        return true;
      case 'new':
        this.options.newConversation(this.profile);
        return true;
      case 'end':
        await this.end();
        return true;
      default:
        return false;
    }
  }

  private appendLocal(note: SharedNote, text: string): void {
    const content = note.content;
    const separator = content.endsWith('\n\n') || !content ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    note.applyOps([{ from: content.length, to: content.length, insert: separator + text }], LOCAL_ORIGIN);
  }

  private async setProperty(key: string, value: string | undefined): Promise<void> {
    this.written[key] = value;
    const note = this.note;
    if (note) {
      const edit = frontmatterEdit(note.content, key, value);
      if (edit) note.applyOps([edit], LOCAL_ORIGIN);
      return;
    }
    await this.app.fileManager.processFrontMatter(this.file, (frontmatter: Record<string, unknown>) => {
      if (value === undefined) delete frontmatter[key];
      else frontmatter[key] = value;
    });
  }

  /** Names a new conversation after its first message. */
  private async rename(message: string): Promise<void> {
    if (!/^New conversation/.test(this.file.basename)) return;
    const folder = this.file.parent?.path ?? '';
    const base = `${window.moment().format('YYYY-MM-DD')} ${titleFrom(message)}`;
    for (let n = 1; n < 100; n++) {
      const path = normalizePath(`${folder}/${n === 1 ? base : `${base} ${n}`}.md`);
      if (!this.app.vault.getAbstractFileByPath(path)) {
        await this.app.fileManager.renameFile(this.file, path);
        return;
      }
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
