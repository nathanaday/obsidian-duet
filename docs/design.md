# Design notes

These notes record the decisions behind agent-helenite and the harness behavior that the code depends on.

## The app starts the harness

There are two ways for an app to talk to an agent:

1. **Start the harness.** The app starts `claude` or `codex` as a child process and talks to it over stdin and stdout.
2. **Attach to a running session.** A server inside a terminal session accepts connections from the app. Claude Code calls this "channels". Codex has a shared app-server daemon.

agent-helenite uses the first way:

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

## Finding the harness binary

An app that starts from the macOS Dock, such as Obsidian, gets only the system PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). The harness binaries are not on that PATH. `codex` is also a Node script, so it needs `node` on the PATH.

`harnessEnvironment` reads PATH from the user's login shell (`$SHELL -ilc`) and adds common install directories. `findExecutable` then looks for the binary on that PATH. The caller can skip the lookup with `executablePath`. Use `env` to choose an account, for example `CLAUDE_CONFIG_DIR`.

## Bundling for Obsidian

An Obsidian plugin is one CommonJS file. The Claude Agent SDK is ESM and calls `createRequire(import.meta.url)`, which is undefined in CommonJS. `scripts/bundle.mjs` replaces `import.meta.url` with a file URL that a banner line defines. Obsidian does not define `__filename`, so the banner has a fallback. The SDK uses this `require` only to find its own bundled binary, and agent-helenite passes `pathToClaudeCodeExecutable`, so the exact path does not matter. The plugin build must use the same `define` and `banner` settings.

The bundle is about 900 KB. The SDK, zod and ajv make up most of it.

Obsidian plugins that start processes work only on desktop. The plugin manifest must set `isDesktopOnly: true`.

## Claude Code loads the user's setup

A session starts Claude Code with the user's settings, plugins and MCP servers, as `claude` does in a terminal. Claude may then mention, for example, connectors that need a sign-in. `sdkOptions` passes any Agent SDK option through. `{ strictMcpConfig: true }` loads only the MCP servers that the caller passes. The demo uses it unless the user selects "Load my MCP servers and plugins".

## The demo app

`demo/` is a Vite and Vue app. `demo/server/api.ts` is a Vite plugin that hosts sessions inside the dev server, so one command starts everything. The browser receives events over Server-Sent Events and sends messages, approvals and interrupts as POST requests. The server keeps each session's event log and replays it when the browser reconnects.

## Licensing and accounts

agent-helenite does not include either harness. It runs the binary that the user installed, with the user's own login. The Claude Agent SDK package is not open source ("All rights reserved", under Anthropic's commercial terms). The plugin bundles the SDK's JavaScript but not its native binary. Anthropic's terms do not let a third-party product offer claude.ai subscription login unless Anthropic approves it. Read the current terms before you publish the plugin.

## Things the adapters do not support yet

- Claude Code's `AskUserQuestion` and `ExitPlanMode` tools come through the permission callback as ordinary tool requests. A UI that wants to answer them needs a dedicated request type.
- Codex `item/tool/requestUserInput` gets an error response. MCP elicitations get `decline`.
- Images and file attachments in user messages.
- Subagent activity. The Claude adapter ignores messages that belong to a subagent.
