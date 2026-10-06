# Design notes

These notes record the decisions behind Duet and the harness behavior that the code depends on.

## The app starts the harness

There are two ways for an app to talk to an agent:

1. **Start the harness.** The app starts `claude` or `codex` as a child process and talks to it over stdin and stdout.
2. **Attach to a running session.** A server inside a terminal session accepts connections from the app. Claude Code calls this "channels". Codex has a shared app-server daemon.

Duet uses the first way:

- The user starts the session from the app, so the app needs no connect-and-approve step.
- Every tool approval comes to the app as a callback. In an attached session, approvals stay in the terminal unless the harness forwards them. Claude Code forwards them only through a preview feature.
- There is one process and one pipe. The app does not need a server, a port, or discovery.

An attach transport can come later, behind the same `AgentSession` interface.

## One interface, one adapter for each harness

`AgentSession` (in `src/session.ts`) is the only API that a UI uses. It has `send`, `interrupt`, `close`, an event stream, and a permission callback. `BaseSession` owns the turn queue and event delivery. An adapter only starts a turn, interrupts it, and calls `turn.finish` when the harness ends the turn.

| | Claude Code | Codex |
|---|---|---|
| Protocol | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk/core`). The SDK runs `claude` and talks stream-JSON to it. | `codex app-server`: JSON-RPC as newline-delimited JSON, without the `"jsonrpc"` field |
| Session id | A UUID that the adapter makes and gives to the SDK as `sessionId` | The thread id that `thread/start` returns |
| Approvals | `canUseTool` callback | Server requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` |
| "Allow for session" | Returns the SDK's permission suggestions as `updatedPermissions` | `acceptForSession`, or a grant with scope `session` |
| Default policy | `permissionMode: 'default'` | `approvalPolicy: 'on-request'`, `sandbox: 'workspace-write'` |

The adapters show every approval prompt that the harness sends. Codex sends fewer prompts by default, because its sandbox lets commands write inside the working directory. Set `approvalPolicy: 'untrusted'` to get a prompt for each command.

## Turns run one at a time

`send` puts the message in a queue. The next turn starts only after the current turn ends. This rule gives each `send` exactly one `TurnResult` and keeps event order simple. Both harnesses can accept a message during a turn (Claude Code merges it into the turn; Codex has `turn/steer`), but the merged result cannot be matched to one `send` call.

A turn becomes active inside `send`, not later. So `interrupt()` directly after `send()` stops that turn.

## Interrupt timing

Both harnesses ignore an interrupt that arrives before the turn starts on their side:

- Codex answers `turn/start` before it registers the turn. A `turn/interrupt` sent at that moment fails with "no active turn to interrupt". Codex sends `turn/started` a few milliseconds later.
- Claude Code reads the user message from stdin a short time after the SDK writes it. An interrupt that arrives first finds nothing to stop, and the turn then runs to the end.

Each adapter records whether the turn has started (`turn/started` for Codex; `system/init`, a stream event or an assistant message for Claude Code). An interrupt before that point waits until the turn starts. The fake Codex server in `test/fixtures` copies the Codex behavior, so a unit test covers this case.

## What a UI receives

Adapters normalize what they show, so every UI gets the same thing from both harnesses:

- File paths inside the working directory are relative (`Ideas.md`, not `/private/var/.../Ideas.md`). Harnesses often report the resolved path, so the comparison also uses the resolved working directory.
- Codex runs commands as `/bin/zsh -lc '<command>'`. Titles show the inner command. The permission detail keeps the full command.
- The detail of a file-change request is a line diff: each line starts with ' ', '-' or '+'. Claude Code sends the old and new text of an edit, and the adapter computes the diff. Codex sends a unified diff.

Both adapters also give:

- `thinking-delta` and `thinking` events with the model's reasoning summary. Claude Code sends them when the setting `showThinkingSummaries` is on; the adapter turns it on. Codex sends reasoning summary deltas.
- `detail` and `paths` on `tool-start`: the command or diff, and the files that the tool reads or changes.
- `models()`, `commands()` and `configure({ model, effort, approval })`. Claude Code's commands are its slash commands and skills. Codex has no slash commands in the app server, so its commands are its skills: `send('/name request')` sends the skill as a `skill` input item.

## Finding the harness binary

An app that starts from the macOS Dock, such as Obsidian, gets only the system PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). The harness binaries are not on that PATH. `codex` is also a Node script, so it needs `node` on the PATH.

`harnessEnvironment` reads PATH from the user's login shell (`$SHELL -ilc`) and adds common install directories. `findExecutable` then looks for the binary on that PATH. The caller can skip the lookup with `executablePath`. Use `env` to choose an account, for example `CLAUDE_CONFIG_DIR`.

## Bundling for Obsidian

An Obsidian plugin is one CommonJS file. The Claude Agent SDK is ESM and calls `createRequire(import.meta.url)`, which is undefined in CommonJS. `scripts/bundle.mjs` replaces `import.meta.url` with a file URL that a banner line defines. Obsidian does not define `__filename`, so the banner has a fallback. The SDK uses this `require` only to find its own bundled binary, and Duet passes `pathToClaudeCodeExecutable`, so the exact path does not matter. The plugin build must use the same `define` and `banner` settings.

The bundle is about 900 KB. The SDK, zod and ajv make up most of it.

Obsidian plugins that start processes work only on desktop. The plugin manifest must set `isDesktopOnly: true`.

## Claude Code loads the user's setup

A session starts Claude Code with the user's settings, plugins and MCP servers, as `claude` does in a terminal. Claude may then mention, for example, connectors that need a sign-in. `sdkOptions` passes any Agent SDK option through. `{ strictMcpConfig: true }` loads only the MCP servers that the caller passes. The demo uses it unless the user selects "Load my MCP servers and plugins".

## The demo app

`demo/` is a Vite and Vue app. `demo/server/api.ts` is a Vite plugin that hosts sessions inside the dev server, so one command starts everything. The browser receives events over Server-Sent Events and sends messages, approvals and interrupts as POST requests. The server keeps each session's event log and replays it when the browser reconnects.

## The Obsidian plugin

The plugin has two ways to work with an agent:

- **Mentions.** The user writes `@claude` and a request on a line of a note. The agent replies in a callout under the line. It can change only that note.
- **Conversation notes.** A note with the property `duet: conversation` is a chat. A message box at the bottom of the note sends messages. The plugin writes the messages, the agent's replies, and its tool calls into the note. When the conversation ends, the note stays as a record.

In both modes, every change that an agent makes to an open note appears with the agent's cursor.

### Shared documents (Yjs)

While an agent works with a note, the note is a shared document: a Yjs `Y.Doc` with one `Y.Text`, in `plugin/src/collab/`. The user and each agent are peers of this document. They exchange Yjs updates in memory; there is no network.

- `SharedNote` owns the document. It is created from the file on disk and the text in the editor, so unsaved typing is part of it.
- `EditorBinding` is a CodeMirror view plugin. It applies each user transaction to the `Y.Text`, and applies each document change to the editor. It ignores sub-editors, such as table cells and embeds, because they write their text back into the note themselves.
- `AgentPeer` is one agent in one note. Its changes use the peer as the Yjs transaction origin.
- `CollabHub` creates and disposes shared notes and connects them to editors.

Changes from the document reach the editor with three settings:

- `addToHistory: false`, so Cmd+Z undoes only the user's own typing.
- `remote: true`.
- `filter: false`. Live Preview has transaction filters that change edits near the frontmatter. A filtered change makes the editor and the document differ.

The command "Undo the agent's last changes in this note" uses a `Y.UndoManager` that tracks only agent origins. Each turn is one undo step. Reply text is written with a separate origin, so the command does not remove replies.

### How agent edits merge

An agent edits a version of the note that can be older than the editor text. The plugin applies the edit to that version and lets Yjs merge it:

1. The plugin takes a Yjs snapshot of the version that the agent read. The document has `gc: false`, so old versions stay available.
2. It forks the document at that snapshot (`Y.createDocFromSnapshot`).
3. It computes the agent's change as diff-match-patch ops against the old text, and applies them to the fork. Each fork update is applied to the shared document.

Text that the user typed after the agent read the note stays where it is. This includes text inside a range that the agent rewrites.

Agents change notes in two ways:

- **Note tools** (mentions). The tools `read_note`, `edit_note` and `write_note` run inside the plugin. Claude Code gets them as an in-process MCP server; Codex gets them as dynamic tools. The version that the agent read is the snapshot from the last `read_note`, or from the message that contained the note.
- **The agent's own file tools** (conversations). Claude Code's Edit and Codex's `apply_patch` write the file on disk. The version that the agent read is the last version on disk. The hub records each save that Obsidian makes (it wraps `Vault.modify`), so it knows which document state matches the disk. When the file changes to anything else, the note forks at that state and merges the change. The change is shown as the agent's when a running tool names the file, or when exactly one agent works with its own file tools.

While an agent works with its own file tools, every note open in an editor is shared, so these changes merge with unsaved typing.

Obsidian reloads an open note when its file changes on disk (`loadFileInternal`, then `setViewData(data, false)`). For a shared note, the hub skips this call and merges the change itself. A reload that kept Obsidian's own result would lose either the user's unsaved typing or the agent's change.

### Cursors and highlights

Each agent publishes its presence with the Yjs awareness protocol: name, color, a status such as "Reading Ideas.md", and a cursor as relative positions. The agent peer has its own `Awareness` instance and sends its updates to the note, as a remote client does.

- The cursor is drawn in a CodeMirror layer. The marker reuses its element, so a CSS transition moves it smoothly.
- In Live Preview, some Markdown, such as a callout, is a rendered widget. CodeMirror places a position inside a widget at its edge, so the cursor goes after the last rendered text in the widget. The binding redraws cursors when the editor DOM changes, because Obsidian renders widgets after the text changes.
- Text that an agent edits is highlighted in the agent's color for about one second, then the highlight fades.
- When the agent works outside the visible part of the editor, a pill at the top or bottom edge shows where. A click scrolls there.

Agent edits play as typing only when an editor shows the note and the setting "Show agents typing" is on. One edit takes at most about 1.3 seconds. The tool call returns after the edit is in the note.

### Writing a reply

`LiveRegion` is a range of a shared note that the agent writes as its own output, such as a reply callout. Its start is anchored to the character before the range and its end to the character after it. The caller sets the text that the range should hold. Appended text is typed a few characters at a time, and other changes apply as small diffs. If the user deletes a reply callout, the region stops writing.

A reply callout is rendered so that streamed text only appends. While the agent works, the agent's cursor shows its status; the callout does not.

In a mention, the agent sees the note with the request line and its reply callout replaced by the line `⟦request and reply⟧`. Edits that overlap this line are cut around it, so the agent cannot change the request or its own reply.

### Conversation notes

A conversation note has this frontmatter:

```yaml
duet: conversation
agent: claude          # the profile name
model: opus            # optional
effort: high           # optional
approval: plan         # optional; otherwise the profile's setting
session: <id>          # the harness session, for resuming
status: active         # or ended
created: 2026-10-05 14:02
cssclasses:
  - duet-conversation
```

The body is Markdown:

- A user message is a `> [!user]` callout.
- Thinking and tool calls between pieces of text go into one collapsed `> [!activity]-` callout. Its title is a summary, for example "Thought for 6s · Read 2 files". Command output and diffs are inside it.
- The agent's text is plain Markdown.

The message box is a DOM element in the note view, not part of the note. It sends messages, suggests slash commands after `/` and notes after `[[`, shows approval requests, and changes the model, effort and approval mode for the next turns. A message sent during a turn waits until the turn ends. Before a turn, the plugin adds one line break at the end of the note and writes the turn before it, so text that the user types at the very end stays outside the turn.

The plugin names a new conversation after its first message, before it sends the message. The first message of each agent process ends with the line `Conversation note: <path> (do not edit it)`, and so does the next message after a rename. The instructions say that the agent can change every other file with its own tools. It keeps the agent process while a view shows the note; an idle process closes after the idle time, and the next message resumes the session from `session`.

### One conversation per note (mentions)

Each note and agent pair has one session. The session ids are saved with the plugin settings, keyed by note path, and follow renames. A session that is idle for 15 minutes closes its process. The next mention resumes the conversation from the saved id.

Events reach the right reply through a queue: each mention adds a reply to its session's queue, and each `turn-start` takes the next one.

### Turns the user did not ask for

Claude Code can run a command in the background and end its turn at once. When the command finishes, Claude Code starts a new turn by itself. A note has no place for that reply, so the plugin sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for Claude sessions, and the instructions ask both agents to wait for commands. A turn that starts without a mention still gets a "(follow-up)" callout at the end of the note. In a conversation note, it gets a turn at the end of the note.

### Agent tags

An editor extension shows each `@name` tag of a configured agent as a pill in the agent's color, like a `#tag`. It uses the same rules as the Enter trigger: `findTags` in `mention.ts` finds the tags, and tags in code, frontmatter, math, blockquotes and email addresses stay plain. The pill shows as soon as the name is complete, before the request, so the user sees that the tag will work. A Reading view post-processor wraps tags in the same pill.

### Contribution ledger

The ledger records which text of each note a Duet agent wrote. The contribution lens shows it.

**What it records.** All text that a Duet agent writes into a shared note: its edits, its mention replies, and its parts of a conversation note. The only source is the transaction origin of a change to a shared note. An `AgentPeer` (an edit) or `peer.writer` (a reply) means the agent; any other origin, such as the user, Obsidian or the disk, means no agent. The ledger records no author for other text. A change by another program, such as an agent that Duet did not start, is not attributed. The ledger does not detect AI-written text.

**Current spans, not a log.** A position in an edit log is correct only for the text at the time of the edit. Every later edit above it moves the text. So the ledger keeps the current spans and moves them through each later change. Spans use character offsets, not line and column, because offsets move through a change with simple arithmetic.

**Whole words.** Character diffs match letters by chance. `# Welcome` → `# Hello from the agent` keeps the `e` and `l`, which would leave them to the user. So a change takes the whole words that it touches: the agent's change makes them the agent's, and any other change makes them no agent's. A letter deleted inside a word counts as a change to the word.

**Changes that Duet does not see.** A note changes while Obsidian is closed, through sync or in another editor. Each ledger file keeps the note text that its spans refer to. When Duet next reads the record, it compares that text with the note and moves the spans through the difference. Words that changed lose their attribution, so the result errs toward "not attributed". The copy of the text is updated at each change, so deleted text can stay in it until then.

**Exact while shared.** While a note is shared, the ledger follows each Yjs change of the note as it happens, in order, so no comparison is needed. The lens of an editor that shows a shared note maps the spans to the editor's text for display only. Only the shared note changes the record.

**Edits to closed notes in conversations.** In a conversation the agent edits files with its own tools. A change merges as the agent's edit only when the note is shared before the change. `SessionOptions.beforeFileChange` runs before a file-editing tool. The conversation shares the named notes there, and the hub releases them when the turn ends. Claude Code runs it as a `PreToolUse` hook and waits for it. Codex waits only when it asks for approval; with the sandbox approval setting, it can apply a change before the note is shared, and that change is not attributed. A shell command that writes a file has no hook. A note that a conversation agent creates with its own tools is the agent's from the start.

**Storage.** One JSON file for each note at `.duet/contributions/<note path>.json`: `{ version, text, spans: [{ from, to, agent, time }] }`. The folder is hidden in Obsidian and moves with the vault in file-based sync. Obsidian Sync does not sync hidden folders. The files follow renames and deletes. A file with no spans left is removed. Saves wait one second after the last change.

**The lens.** In the editor, agent text has a mark with a tooltip that names the agent and the date. Live Preview renders some blocks, such as callouts and tables, as widgets, and a mark inside a widget does not show. A widget that holds agent text gets a bar on its left edge instead. Reading view has no source positions in its rendered text, so it marks whole sections.

### Node's events module in Electron

In Obsidian's renderer, `AbortController` is the browser's. The Claude Agent SDK calls `events.setMaxListeners(n, signal)`, and Node rejects a browser `AbortSignal`. The bundle maps `events` to `scripts/shims/node-events.cjs`, which forwards everything to Node's module except that `setMaxListeners` skips browser event targets. The plugin does not patch the global module, so other plugins are not affected.

### Testing in a separate Obsidian

`test/obsidian/harness.ts` starts Obsidian with `--user-data-dir` set to a temporary profile and `--remote-debugging-port`, so it runs beside the user's own Obsidian and does not share its settings or vaults. Playwright connects over the Chrome DevTools Protocol and types into the editor as a user does. The harness enables the plugin once with `enablePluginAndSave`. If the plugin is also listed in `community-plugins.json`, turning on community plugins loads a second instance. After each test, the suite checks that every open shared note has the same text in the editor and in the document.

On macOS, Obsidian shows menus as native menus by default. Screenshots do not include them.

## Licensing and accounts

Duet does not include either harness. It runs the binary that the user installed, with the user's own login. The Claude Agent SDK package is not open source ("All rights reserved", under Anthropic's commercial terms). The plugin bundles the SDK's JavaScript but not its native binary. Anthropic's terms do not let a third-party product offer claude.ai subscription login unless Anthropic approves it. Read the current terms before you publish the plugin.

## App tools

`SessionOptions.tools` gives the agent tools that run inside the app. A tool has a name, a description, a zod input shape and a `run` function. The agent calls them without approval.

- Claude Code: the adapter creates an in-process MCP server (`createSdkMcpServer`). The tool names are `mcp__<set>__<tool>`. `canUseTool` allows them.
- Codex: the adapter sends them as `dynamicTools` in `thread/start` and answers `item/tool/call` requests. Dynamic tools are part of the experimental API, so the adapter sets `experimentalApi` in `initialize` when the session has tools.

`access: 'read-only'` limits Claude Code to Read, Glob, Grep, WebSearch and WebFetch, and runs Codex with the `read-only` sandbox and approval policy `never`. Mentions use it with the note tools.

## Things the adapters do not support yet

- Claude Code's `AskUserQuestion` and `ExitPlanMode` tools come through the permission callback as ordinary tool requests. A UI that wants to answer them needs a dedicated request type.
- Codex `item/tool/requestUserInput` gets an error response. MCP elicitations get `decline`.
- Images and file attachments in user messages.
- Subagent activity. The Claude adapter ignores messages that belong to a subagent.
