import type { ClaudeSessionOptions } from './adapters/claude.ts';
import type { CodexSessionOptions } from './adapters/codex/session.ts';
import type { Harness } from './session.ts';

/**
 * One approval setting for both harnesses.
 * - `ask`: ask before edits and commands (Claude Code), or before every command (Codex).
 * - `accept-edits`: Claude Code edits files without asking. Codex treats it as `ask`.
 * - `plan`: Claude Code only reads and plans. Codex treats it as `ask`.
 * - `sandbox`: Codex works freely inside its sandbox. Claude Code treats it as `ask`.
 */
export type ApprovalSetting = 'ask' | 'accept-edits' | 'plan' | 'sandbox';

export function claudePermissionMode(setting: ApprovalSetting): 'acceptEdits' | 'plan' | 'default' {
  return setting === 'accept-edits' ? 'acceptEdits' : setting === 'plan' ? 'plan' : 'default';
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
