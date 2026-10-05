import type { AgentEvent, ApprovalSetting, Harness, PermissionDecision } from '../../src/index.ts';

export type { AgentEvent, ApprovalSetting, Harness, PermissionDecision };

export interface DemoInfo {
  harnesses: Record<Harness, { available: boolean; error?: string }>;
}

export interface StartRequest {
  harness: Harness;
  /** Empty: the session gets a fresh copy of the sample vault. */
  cwd: string;
  approval: ApprovalSetting;
  /** Load the user's own MCP servers and plugins. Claude Code only. */
  userTools: boolean;
  resume?: string;
}

export interface SessionInfo {
  id: string;
  harness: Harness;
  cwd: string;
}

/** Everything the event stream carries: the library's own events, plus the permission round trip. */
export type WireEvent =
  | AgentEvent
  | { type: 'permission-request'; requestId: string; tool: string; title: string; detail?: string }
  | { type: 'permission-resolved'; requestId: string; decision: PermissionDecision | 'cancelled' };

export interface Envelope {
  seq: number;
  /** Milliseconds since the session started. */
  at: number;
  event: WireEvent;
}
