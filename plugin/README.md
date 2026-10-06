# Helenite for Obsidian

Work with Claude Code or Codex inside your notes. You and the agent edit the same note at the same time, and you see the agent's cursor and each change it makes.

- **Mention:** write `@claude` and a request on any line, then press Enter. The answer streams into a callout under the line. Ask it to change the note, for example "@claude clean this up for style and wording", and it edits the note while you keep typing.
- **Conversation note:** run **New conversation**. You get a note with a message box at the bottom. The note records the conversation: your messages, the agent's replies, and its tool calls in collapsed callouts. When you end the conversation, the note stays as a record.

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

### Mentions

- **Ask:** write `@claude` or `@codex`, then your request, and press Enter at the end of the line. The tag can follow other text on the line.
- **Edit the note:** ask for a change, such as "@claude make the list shorter". The agent changes this note only. It can read other notes, but it cannot change them or run commands that change files, so a mention never asks for approval.
- **Follow up:** each note keeps its own conversation, so a later `@claude make it shorter` in the same note continues it. The conversation survives an Obsidian restart.
- **Undo the agent:** run **Helenite: Undo the agent's last changes in this note**. It removes the edits of the agent's last turn and keeps your own typing and the agent's reply. Cmd+Z undoes only your own typing.
- **Stop:** run **Helenite: Stop the agent in this note**. Assign it a hotkey if you use it often.
- **Start over:** run **Helenite: Forget the mention conversation in this note**.

The plugin ignores tags in code blocks, in blockquotes, and in email addresses.

### Conversation notes

- **Start:** run **Helenite: New conversation**, or click the ribbon button. With more than one agent, there is a command for each agent. The note goes in the conversation folder (default `Conversations`) and gets its name from your first message.
- **Send:** type in the message box and press Enter. Shift+Enter starts a new line. A message sent while the agent works waits for the current turn.
- **Link notes:** type `[[` to pick a note. The agent gets the paths of linked notes and reads them when it needs them.
- **Commands:** type `/` to see commands. `/model`, `/effort`, `/mode`, `/new` and `/end` are the plugin's. The other commands come from the agent, for example Claude Code's skills.
- **Model, effort and approvals:** use the buttons under the message box. The choice applies to the next turns and is saved in the note's properties.
- **Approve:** when the agent wants to change a file or run a command, the request shows above the message box. Press `Y` to allow once, `A` to allow for the rest of the conversation, or `N` to deny.
- **Stop:** press Escape in the message box, or click the stop button.
- **End:** type `/end`, or run **Helenite: End this conversation**. The note stays as a record. **Continue it** reopens the conversation.

In a conversation the agent can change any file in the vault, with the approvals you choose. Its changes to open notes show its cursor, and they merge with text you type at the same time.

## Settings

Each agent has a tag, a harness, and options:

| Setting | What it does |
|---|---|
| Tag | The name after `@`. |
| Color | The color of the agent's cursor and highlights. |
| Agent | Claude Code or Codex. |
| Approvals | When the agent asks before it acts, in conversation notes. |
| Model | Leave empty for the default. |
| Effort | How much the model reasons. Leave empty for the default. |
| Program path | Leave empty to find the program on your shell's PATH. |
| Environment variables | One `KEY=VALUE` per line. |
| Load my MCP servers and plugins | Claude Code only. Off by default. |

General settings:

| Setting | What it does |
|---|---|
| Conversation folder | Where new conversation notes go. |
| Show agents typing | Agents type their edits into open notes. Off: edits appear at once. The plugin also turns this off when the system asks for reduced motion. |
| Close idle agents after | Minutes without activity before an agent process stops. The next message continues the same conversation. |

To use a second Claude account, add an agent with the tag `work`, the harness Claude Code, and the environment variable `CLAUDE_CONFIG_DIR=~/.claude-work`.

## Tests

Run `npm run plugin:build`, then `npm run test:obsidian`. The test starts a separate Obsidian with its own profile and a temporary vault, installs the plugin, and drives it through real mentions and conversations with Claude Code and Codex. Your own Obsidian and vaults are not touched.
