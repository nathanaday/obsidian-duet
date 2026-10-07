import type { ClaudeSessionOptions } from './adapters/claude.ts';
import type { CodexSessionOptions } from './adapters/codex/session.ts';
import type { Harness } from './session.ts';

/**
 * One approval setting for both harnesses.
 * - `ask`: ask before edits and commands (Claude Code), or before every command (Codex).
 * - `accept-edits`: Claude Code edits files without asking. Codex treats it as `ask`.
 * - `plan`: Claude Code only reads and plans. Codex treats it as `ask`.
 * - `auto`: Claude Code decides which actions are safe to run without asking. Codex treats it as `ask`.
 * - `sandbox`: Codex works freely inside its sandbox. Claude Code treats it as `ask`.
 */
export type ApprovalSetting = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'sandbox';

const CLAUDE_MODES = { ask: 'default', 'accept-edits': 'acceptEdits', plan: 'plan', auto: 'auto', sandbox: 'default' } as const;

export function claudePermissionMode(setting: ApprovalSetting): (typeof CLAUDE_MODES)[ApprovalSetting] {
  return CLAUDE_MODES[setting];
}

export function codexApprovalPolicy(setting: ApprovalSetting): 'on-request' | 'untrusted' {
  return setting === 'sandbox' ? 'on-request' : 'untrusted';
}

export function approvalOptions(
  harness: Harness,
  setting: ApprovalSetting,
): Pick<ClaudeSessionOptions, 'permissionMode'> | Pick<CodexSessionOptions, 'approvalPolicy' | 'sandbox'> {
  if (harness === 'claude') {
    return { permissionMode: claudePermissionMode(setting) };
  }
  return { approvalPolicy: codexApprovalPolicy(setting), sandbox: 'workspace-write' };
}
