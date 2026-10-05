import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { AgentManager, type SessionIndex } from './agents.ts';
import { enterTrigger } from './enter-trigger.ts';
import { PermissionPrompts } from './permission-modal.ts';
import { DEFAULT_SETTINGS, displayName, type HeleniteSettings, HeleniteSettingTab } from './settings.ts';

interface PluginData {
  settings: HeleniteSettings;
  sessions: SessionIndex;
}

export default class HelenitePlugin extends Plugin {
  settings: HeleniteSettings = structuredClone(DEFAULT_SETTINGS);
  private sessions: SessionIndex = {};
  private agents!: AgentManager;
  private statusEl!: HTMLElement;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...data.settings };
    this.sessions = data.sessions ?? {};

    this.agents = new AgentManager(this.app, this.sessions, new PermissionPrompts(this.app), {
      idleMinutes: () => this.settings.idleMinutes,
      save: () => this.persist(),
      onActivity: () => this.updateStatus(),
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('helenite-status');
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
          if (profile) void this.agents.ask({ ...mention, profile });
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
          void this.agents.interrupt(file).then((count) => {
            if (!count) new Notice('No agent is working in this note.');
          });
        }
        return true;
      },
    });

    this.addCommand({
      id: 'new-conversation',
      name: 'Start a new conversation in this note',
      checkCallback: (checking) => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) {
          void this.agents.forget(file).then(() => new Notice('The next mention in this note starts a new conversation.'));
        }
        return true;
      },
    });

    this.addSettingTab(new HeleniteSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) void this.agents.rename(file, oldPath);
      }),
    );
  }

  async onunload(): Promise<void> {
    await this.agents.closeAll();
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    await this.agents.closeIdle();
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

  private updateStatus(): void {
    const working = this.agents.working;
    this.statusEl.setText(working ? `${working} ${working === 1 ? 'agent' : 'agents'} working` : '');
    this.statusEl.toggleClass('is-working', working > 0);
  }
}
