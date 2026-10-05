import { type App, PluginSettingTab, Setting } from 'obsidian';
import type { ApprovalSetting, Harness } from '../../src/index.ts';
import type HelenitePlugin from './main.ts';

export interface AgentProfile {
  /** The tag without `@`. */
  name: string;
  harness: Harness;
  /** Empty: find the binary on the login shell PATH. */
  executablePath: string;
  /** Extra environment variables, one KEY=VALUE per line. */
  env: string;
  /** Empty: the harness default. */
  model: string;
  approval: ApprovalSetting;
  /** Claude Code only: load the user's own MCP servers and plugins. */
  userTools: boolean;
}

export interface HeleniteSettings {
  profiles: AgentProfile[];
  /** Minutes before an idle agent process closes. Its conversation resumes on the next mention. */
  idleMinutes: number;
}

export const DEFAULT_SETTINGS: HeleniteSettings = {
  profiles: [
    { name: 'claude', harness: 'claude', executablePath: '', env: '', model: '', approval: 'ask', userTools: false },
    { name: 'codex', harness: 'codex', executablePath: '', env: '', model: '', approval: 'ask', userTools: false },
  ],
  idleMinutes: 15,
};

const HARNESS_NAMES: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };

const APPROVALS: Record<Harness, Partial<Record<ApprovalSetting, string>>> = {
  claude: { ask: 'Ask before edits and commands', 'accept-edits': 'Allow edits, ask before commands', plan: 'Plan only' },
  codex: { ask: 'Ask before every command', sandbox: 'Ask only outside the sandbox' },
};

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const index = trimmed.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || index < 1) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
  }
  return env;
}

export function displayName(profile: AgentProfile): string {
  return profile.name.charAt(0).toUpperCase() + profile.name.slice(1);
}

export class HeleniteSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: HelenitePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('p', {
      cls: 'helenite-settings-intro',
      text: 'Write @name followed by a request on a line of a note, then press Enter. The agent replies in a callout under the line. Each note keeps its own conversation.',
    });

    new Setting(containerEl).setName('Agents').setHeading();

    this.plugin.settings.profiles.forEach((profile, index) => this.displayProfile(containerEl, profile, index));

    new Setting(containerEl).addButton((button) =>
      button.setButtonText('Add agent').onClick(async () => {
        this.plugin.settings.profiles.push({ ...DEFAULT_SETTINGS.profiles[0]!, name: this.unusedName() });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    new Setting(containerEl).setName('General').setHeading();

    new Setting(containerEl)
      .setName('Close idle agents after')
      .setDesc('Minutes without a mention before an agent process stops. The next mention in the note continues the same conversation.')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.idleMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          if (Number.isFinite(minutes) && minutes > 0) {
            this.plugin.settings.idleMinutes = minutes;
            await this.plugin.saveSettings();
          }
        }),
      );
  }

  private displayProfile(containerEl: HTMLElement, profile: AgentProfile, index: number): void {
    const group = containerEl.createDiv({ cls: 'helenite-profile' });
    const save = () => this.plugin.saveSettings();

    new Setting(group)
      .setName(`@${profile.name}`)
      .setDesc(HARNESS_NAMES[profile.harness])
      .setClass('helenite-profile-title')
      .addExtraButton((button) =>
        button
          .setIcon('trash')
          .setTooltip(`Remove @${profile.name}`)
          .onClick(async () => {
            this.plugin.settings.profiles.splice(index, 1);
            await save();
            this.display();
          }),
      );

    new Setting(group)
      .setName('Tag')
      .setDesc('The name you write after @. Letters, digits, - and _.')
      .addText((text) =>
        text.setValue(profile.name).onChange(async (value) => {
          const name = value.trim().replace(/^@/, '');
          if (!/^[\w-]+$/.test(name) || this.nameTaken(name, index)) return;
          profile.name = name;
          await save();
        }),
      );

    new Setting(group).setName('Agent').addDropdown((dropdown) =>
      dropdown
        .addOptions(HARNESS_NAMES)
        .setValue(profile.harness)
        .onChange(async (value) => {
          profile.harness = value as Harness;
          if (!APPROVALS[profile.harness][profile.approval]) profile.approval = 'ask';
          await save();
          this.display();
        }),
    );

    new Setting(group).setName('Approvals').addDropdown((dropdown) =>
      dropdown
        .addOptions(APPROVALS[profile.harness] as Record<string, string>)
        .setValue(profile.approval)
        .onChange(async (value) => {
          profile.approval = value as ApprovalSetting;
          await save();
        }),
    );

    new Setting(group)
      .setName('Model')
      .setDesc('Leave empty for the default model.')
      .addText((text) =>
        text.setValue(profile.model).onChange(async (value) => {
          profile.model = value.trim();
          await save();
        }),
      );

    new Setting(group)
      .setName('Program path')
      .setDesc(`Leave empty to find ${profile.harness} on your shell's PATH.`)
      .addText((text) =>
        text
          .setPlaceholder(`/usr/local/bin/${profile.harness}`)
          .setValue(profile.executablePath)
          .onChange(async (value) => {
            profile.executablePath = value.trim();
            await save();
          }),
      );

    new Setting(group)
      .setName('Environment variables')
      .setDesc('One KEY=VALUE per line. For example, CLAUDE_CONFIG_DIR=~/.claude-work uses a second Claude account.')
      .addTextArea((text) =>
        text.setValue(profile.env).onChange(async (value) => {
          profile.env = value;
          await save();
        }),
      );

    if (profile.harness === 'claude') {
      new Setting(group)
        .setName('Load my MCP servers and plugins')
        .setDesc('Off: the agent uses only its built-in tools.')
        .addToggle((toggle) =>
          toggle.setValue(profile.userTools).onChange(async (value) => {
            profile.userTools = value;
            await save();
          }),
        );
    }
  }

  private nameTaken(name: string, except: number): boolean {
    return this.plugin.settings.profiles.some(
      (profile, index) => index !== except && profile.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private unusedName(): string {
    for (let n = 2; ; n++) if (!this.nameTaken(`agent${n}`, -1)) return `agent${n}`;
  }
}
