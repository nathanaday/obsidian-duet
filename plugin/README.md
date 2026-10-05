# Helenite for Obsidian

Ask Claude Code or Codex a question from any line of a note. Write `@claude` and your request, press Enter, and the answer streams into a callout under the line. You stay in your note the whole time, and the agent can read and change the files in your vault when the request needs it.

```markdown
@claude Collect the action items from the standup notes, with owners
> [!agent]+ Claude
> - Review the export feature before Friday (Ana)
> - Get the staging API keys from IT (Jun)
> - Draft the plan for the plugin settings page (Jun)
```

Status: in development. Desktop only.

## Setup

### Prerequisites

- Obsidian 1.8 or later, on desktop
- Claude Code (`claude`) or the Codex CLI (`codex`), installed and logged in. The plugin uses your own installation and login.

### Install from this repository

```sh
npm install
npm run plugin:build                                  # builds plugin/dist
node scripts/plugin.mjs --vault /path/to/your/vault   # copies the plugin into the vault
```

In Obsidian, open **Settings → Community plugins**, turn off restricted mode if it is on, and turn on **Helenite**.

To try it in a sandbox first, run `npm run plugin:dev`. It creates `dev-vault/` with sample notes and rebuilds the plugin into it whenever the code changes. Open `dev-vault/` as a vault in Obsidian.

## Usage

- **Ask:** write `@claude` or `@codex`, then your request, and press Enter at the end of the line. The tag can follow other text on the line.
- **Follow up:** each note keeps its own conversation, so a later `@claude make it shorter` in the same note continues it. The conversation survives an Obsidian restart.
- **Approve:** when the agent wants to change a file or run a command, a dialog shows the command or the change. Press `Y` to allow once, `A` to allow for the rest of the conversation, or `N` to deny.
- **Stop:** run **Helenite: Stop the agent in this note** from the command palette. Assign it a hotkey if you use it often.
- **Start over:** run **Helenite: Start a new conversation in this note**.

The plugin ignores tags in code blocks, in blockquotes, and in email addresses.

## Settings

Each agent has a tag, a harness, and options:

| Setting | What it does |
|---|---|
| Tag | The name after `@`. |
| Agent | Claude Code or Codex. |
| Approvals | When the agent asks before it acts. |
| Model | Leave empty for the default. |
| Program path | Leave empty to find the program on your shell's PATH. |
| Environment variables | One `KEY=VALUE` per line. |
| Load my MCP servers and plugins | Claude Code only. Off by default. |

To use a second Claude account, add an agent with the tag `work`, the harness Claude Code, and the environment variable `CLAUDE_CONFIG_DIR=~/.claude-work`.

## Tests

Run `npm run plugin:build`, then `npm run test:obsidian`. The test starts a separate Obsidian with its own profile and a temporary vault, installs the plugin, and drives it through real mentions with Claude Code and Codex. Your own Obsidian and vaults are not touched.
