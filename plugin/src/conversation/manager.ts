import { type App, MarkdownView, normalizePath, type Plugin, TFile } from 'obsidian';
import type { ConversationStatus, NewConversationOptions, TurnEnd } from '../api.ts';
import type { CollabHub } from '../collab/hub.ts';
import type { PermissionPrompts } from '../permission-modal.ts';
import { type AgentProfile, profileNamed } from '../settings.ts';
import { Composer } from './composer.ts';
import { ConversationController, nameFrom, unnamed } from './controller.ts';
import { availablePath, KIND, KIND_KEY, newConversation, noteName } from './format.ts';

export interface ConversationOptions {
  profiles: () => AgentProfile[];
  folder: () => string;
  animate: () => boolean;
  idleMinutes: () => number;
  onActivity: () => void;
}

export interface CreateOptions {
  /** Default: a placeholder name, which the first message replaces. */
  name?: string;
  /** Default: the conversation folder setting. */
  folder?: string;
  /** Where the note opens. Default: the current tab. */
  open?: 'current' | 'tab' | false;
  userSetup?: boolean;
}

/** How long to wait for the metadata cache to read a new note. */
const INDEX_TIMEOUT_MS = 5000;

/** Finds conversation notes in open views, gives each view a composer, and creates new conversations. */
export class ConversationManager {
  private readonly controllers = new Map<TFile, ConversationController>();
  private readonly composers = new Map<MarkdownView, Composer>();
  private readonly turnListeners = new Map<TFile, Set<(turn: TurnEnd) => void>>();
  private destroyed = false;

  constructor(
    private readonly app: App,
    private readonly hub: CollabHub,
    private readonly prompts: PermissionPrompts,
    private readonly options: ConversationOptions,
  ) {}

  install(plugin: Plugin): void {
    const sync = () => this.sync();
    plugin.registerEvent(this.app.workspace.on('layout-change', sync));
    plugin.registerEvent(this.app.workspace.on('file-open', sync));
    plugin.registerEvent(this.app.workspace.on('active-leaf-change', sync));
    plugin.registerEvent(this.app.metadataCache.on('changed', (file) => this.controllers.has(file) || this.isConversation(file) ? sync() : undefined));
    plugin.registerEvent(this.app.vault.on('delete', (file) => file instanceof TFile && void this.dispose(file)));
    this.app.workspace.onLayoutReady(sync);
  }

  isConversation(file: TFile | null | undefined): file is TFile {
    return Boolean(file && this.app.metadataCache.getFileCache(file)?.frontmatter?.[KIND_KEY] === KIND);
  }

  /** The controllers of conversations that are working now. */
  get working(): ConversationController[] {
    return [...this.controllers.values()].filter((controller) => controller.working);
  }

  controller(file: TFile): ConversationController | undefined {
    return this.controllers.get(file);
  }

  /** Creates a conversation note and opens it, with the cursor in the composer. */
  async create(profile: AgentProfile, options: CreateOptions = {}): Promise<TFile> {
    const folder = normalizePath((options.folder ?? this.options.folder()) || '/');
    if (folder !== '/' && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const path = availablePath(folder, options.name ?? unnamed(), (candidate) => Boolean(this.app.vault.getAbstractFileByPath(candidate)));
    const file = await this.app.vault.create(
      path,
      newConversation({
        agent: profile.name,
        model: profile.model || undefined,
        effort: profile.effort || undefined,
        status: 'active',
        created: window.moment().format('YYYY-MM-DD HH:mm'),
        userSetup: options.userSetup,
      }),
    );
    // A controller reads its agent from the note's properties.
    await this.indexed(file);
    const open = options.open ?? 'current';
    if (open) {
      const leaf = this.app.workspace.getLeaf(open === 'tab' ? 'tab' : false);
      await leaf.openFile(file, { state: { mode: 'source' }, active: true });
      this.sync();
      this.composers.get(leaf.view as MarkdownView)?.focus();
    }
    return file;
  }

  /** Creates a conversation note for another plugin and sends its first message. */
  async start(options: NewConversationOptions): Promise<TFile> {
    if (this.destroyed) throw new Error('Duet is turned off.');
    const message = typeof options.message === 'string' ? options.message.trim() : '';
    if (!message) throw new Error('A new conversation needs a message.');
    const profiles = this.options.profiles();
    const profile = options.profile === undefined ? profiles[0] : profileNamed(profiles, options.profile);
    if (!profile) {
      throw new Error(options.profile === undefined ? 'Duet has no agents.' : `Duet has no agent named ${options.profile}. Agents: ${profiles.map((p) => p.name).join(', ')}.`);
    }
    const file = await this.create(profile, {
      name: (typeof options.title === 'string' && noteName(options.title)) || nameFrom(message),
      folder: options.folder,
      open: options.open === false ? false : 'tab',
      userSetup: options.loadUserSetup === true,
    });
    void this.controllerFor(file).send(message);
    return file;
  }

  status(path: string): ConversationStatus {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!this.isConversation(file)) return 'none';
    const controller = this.controllers.get(file);
    if (controller?.working) return 'working';
    const ended = controller ? controller.ended : this.app.metadataCache.getFileCache(file)?.frontmatter?.status === 'ended';
    return ended ? 'ended' : 'active';
  }

  /** Follows the note, not the path, so a rename keeps the listener. */
  onTurnEnd(path: string, listener: (turn: TurnEnd) => void): () => void {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) return () => undefined;
    let listeners = this.turnListeners.get(file);
    if (!listeners) this.turnListeners.set(file, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.turnListeners.get(file) === listeners) this.turnListeners.delete(file);
    };
  }

  /** The composer of the active view, if it shows a conversation. */
  activeComposer(): Composer | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? this.composers.get(view) : undefined;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.turnListeners.clear();
    for (const composer of this.composers.values()) composer.destroy();
    this.composers.clear();
    await Promise.all([...this.controllers.values()].map((controller) => controller.destroy()));
    this.controllers.clear();
  }

  private sync(): void {
    const views = new Set<MarkdownView>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && this.isConversation(leaf.view.file)) views.add(leaf.view);
    });
    for (const [view, composer] of this.composers) {
      if (!views.has(view) || composer.controller.file !== view.file) {
        composer.destroy();
        this.composers.delete(view);
      }
    }
    for (const view of views) {
      if (this.composers.has(view)) continue;
      this.composers.set(view, new Composer(this.app, view, this.controllerFor(view.file!)));
    }
  }

  private controllerFor(file: TFile): ConversationController {
    let controller = this.controllers.get(file);
    if (!controller) {
      controller = new ConversationController(this.app, this.hub, file, this.options.profiles, this.prompts, {
        animate: this.options.animate,
        idleMinutes: this.options.idleMinutes,
        newConversation: (profile) => void this.create(profile),
        onActivity: this.options.onActivity,
        onTurnEnd: (turn) => this.turnEnded(file, turn),
      });
      controller.subscribe(this.options.onActivity);
      this.controllers.set(file, controller);
    }
    return controller;
  }

  private turnEnded(file: TFile, turn: TurnEnd): void {
    for (const listener of [...(this.turnListeners.get(file) ?? [])]) {
      try {
        listener(turn);
      } catch (error) {
        console.error('Duet: a turn-end listener failed', error);
      }
    }
  }

  /** Resolves when the metadata cache shows the note as a conversation, or after a timeout. */
  private indexed(file: TFile): Promise<void> {
    if (this.isConversation(file)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.app.metadataCache.offref(ref);
        window.clearTimeout(timer);
        resolve();
      };
      const ref = this.app.metadataCache.on('changed', (changed) => changed === file && done());
      const timer = window.setTimeout(done, INDEX_TIMEOUT_MS);
    });
  }

  private async dispose(file: TFile): Promise<void> {
    this.turnListeners.delete(file);
    const controller = this.controllers.get(file);
    if (!controller) return;
    this.controllers.delete(file);
    for (const [view, composer] of this.composers) {
      if (composer.controller === controller) {
        composer.destroy();
        this.composers.delete(view);
      }
    }
    await controller.destroy();
  }
}
