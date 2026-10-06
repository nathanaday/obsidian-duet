import { type App, MarkdownView, normalizePath, type Plugin, TFile } from 'obsidian';
import type { CollabHub } from '../collab/hub.ts';
import type { PermissionPrompts } from '../permission-modal.ts';
import type { AgentProfile } from '../settings.ts';
import { Composer } from './composer.ts';
import { ConversationController } from './controller.ts';
import { KIND, KIND_KEY, newConversation } from './format.ts';

export interface ConversationOptions {
  profiles: () => AgentProfile[];
  folder: () => string;
  animate: () => boolean;
  idleMinutes: () => number;
  onActivity: () => void;
}

/** Finds conversation notes in open views, gives each view a composer, and creates new conversations. */
export class ConversationManager {
  private readonly controllers = new Map<TFile, ConversationController>();
  private readonly composers = new Map<MarkdownView, Composer>();

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
  async create(profile: AgentProfile): Promise<void> {
    const folder = normalizePath(this.options.folder() || '/');
    if (folder !== '/' && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const stamp = window.moment();
    let path = '';
    for (let n = 1; ; n++) {
      path = normalizePath(`${folder}/New conversation ${stamp.format('YYYY-MM-DD HHmm')}${n > 1 ? ` ${n}` : ''}.md`);
      if (!this.app.vault.getAbstractFileByPath(path)) break;
    }
    const file = await this.app.vault.create(
      path,
      newConversation({
        agent: profile.name,
        model: profile.model || undefined,
        effort: profile.effort || undefined,
        status: 'active',
        created: stamp.format('YYYY-MM-DD HH:mm'),
      }),
    );
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { state: { mode: 'source' } });
    // The metadata cache reads the new file a moment later.
    for (let attempt = 0; attempt < 40 && !this.composers.has(leaf.view as MarkdownView); attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      this.sync();
    }
    this.composers.get(leaf.view as MarkdownView)?.focus();
  }

  /** The composer of the active view, if it shows a conversation. */
  activeComposer(): Composer | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? this.composers.get(view) : undefined;
  }

  async destroy(): Promise<void> {
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
      });
      controller.subscribe(this.options.onActivity);
      this.controllers.set(file, controller);
    }
    return controller;
  }

  private async dispose(file: TFile): Promise<void> {
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
