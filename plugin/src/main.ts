import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { bindingPlugin } from './collab/binding.ts';
import { CollabHub } from './collab/hub.ts';
import { presenceExtensions } from './collab/presence.ts';
import { ConversationManager } from './conversation/manager.ts';
import { enterTrigger } from './enter-trigger.ts';
import { MentionAgents, type SessionIndex } from './mentions.ts';
import { PermissionPrompts } from './permission-modal.ts';
import { displayName, type DuetSettings, DuetSettingTab, upgradeSettings } from './settings.ts';

interface PluginData {
  settings: DuetSettings;
  sessions: SessionIndex;
}

export default class DuetPlugin extends Plugin {
  settings!: DuetSettings;
  hub!: CollabHub;
  mentions!: MentionAgents;
  conversations!: ConversationManager;
  private sessions: SessionIndex = {};
  private statusEl!: HTMLElement;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = upgradeSettings(data.settings);
    this.sessions = data.sessions ?? {};

    const animate = () => this.settings.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.hub = new CollabHub(this.app);
    this.hub.install(this, [bindingPlugin, presenceExtensions]);

    const prompts = new PermissionPrompts(this.app);
    this.conversations = new ConversationManager(this.app, this.hub, prompts, {
      profiles: () => this.settings.profiles,
      folder: () => this.settings.conversationFolder,
      animate,
      idleMinutes: () => this.settings.idleMinutes,
      onActivity: () => this.updateStatus(),
    });
    this.conversations.install(this);

    this.mentions = new MentionAgents(this.app, this.hub, this.sessions, prompts, {
      idleMinutes: () => this.settings.idleMinutes,
      animate,
      save: () => this.persist(),
      onActivity: () => this.updateStatus(),
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('duet-status');
    this.statusEl.addEventListener('click', () => {
      const working = this.working()[0];
      if (working) void this.app.workspace.getLeaf(false).openFile(working.file);
    });

    this.addRibbonIcon('message-square-plus', 'New conversation', () => void this.conversations.create(this.settings.profiles[0]!));
    this.addCommand({
      id: 'new-chat',
      name: 'New conversation',
      callback: () => void this.conversations.create(this.settings.profiles[0]!),
    });
    for (const profile of this.settings.profiles.slice(1)) {
      this.addCommand({
        id: `new-chat-${profile.name}`,
        name: `New conversation with ${displayName(profile)}`,
        callback: () => void this.conversations.create(profile),
      });
    }
    this.addCommand({
      id: 'end-chat',
      name: 'End this conversation',
      checkCallback: (checking) => {
        const file = this.activeFile();
        const controller = file && this.conversations.controller(file);
        if (!controller || controller.ended) return false;
        if (!checking) void controller.end();
        return true;
      },
    });
    this.addCommand({
      id: 'focus-composer',
      name: 'Focus the message box',
      checkCallback: (checking) => {
        const composer = this.conversations.activeComposer();
        if (!composer) return false;
        if (!checking) composer.focus();
        return true;
      },
    });
    this.updateStatus();

    this.registerEditorExtension(
      enterTrigger(
        () => this.settings.profiles.map((profile) => profile.name),
        (name) => {
          const profile = this.profile(name);
          return profile ? displayName(profile) : name;
        },
        (mention) => {
          const profile = this.profile(mention.name);
          if (profile) void this.mentions.ask({ ...mention, profile });
        },
      ),
    );

    this.addCommand({
      id: 'stop',
      name: 'Stop the agent in this note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) {
          const controller = this.conversations.controller(file);
          if (controller?.working) {
            void controller.interrupt();
            return true;
          }
          void this.mentions.interrupt(file).then((count) => {
            if (!count) new Notice('No agent is working in this note.');
          });
        }
        return true;
      },
    });

    this.addCommand({
      id: 'revert',
      name: "Undo the agent's last changes in this note",
      checkCallback: (checking) => {
        const file = this.activeFile();
        const note = file && this.hub.get(file.path);
        if (!note?.agentUndo.canUndo()) return false;
        if (!checking) this.mentions.revert(note);
        return true;
      },
    });

    this.addCommand({
      id: 'new-conversation',
      name: 'Forget the mention conversation in this note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) {
          void this.mentions.forget(file).then(() => new Notice('The next mention in this note starts a new conversation.'));
        }
        return true;
      },
    });

    this.addSettingTab(new DuetSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) void this.mentions.rename(file, oldPath);
      }),
    );
  }

  onunload(): void {
    void this.shutdown();
  }

  private async shutdown(): Promise<void> {
    await this.conversations.destroy();
    await this.mentions.closeAll();
    this.hub.destroy();
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    await this.mentions.closeIdle();
  }

  private persist(): Promise<void> {
    return this.saveData({ settings: this.settings, sessions: this.sessions } satisfies PluginData);
  }

  private profile(name: string) {
    return this.settings.profiles.find((profile) => profile.name.toLowerCase() === name.toLowerCase());
  }

  private activeFile(): TFile | undefined {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? undefined;
  }

  private working(): { name: string; file: TFile }[] {
    return [
      ...this.mentions.working,
      ...this.conversations.working.map((controller) => ({ name: controller.agentName, file: controller.file })),
    ];
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const working = this.working();
    const text = working.length === 1 ? `${working[0]!.name} working in ${working[0]!.file.basename}` : working.length ? `${working.length} agents working` : '';
    this.statusEl.setText(text);
    this.statusEl.toggleClass('is-working', working.length > 0);
  }
}
