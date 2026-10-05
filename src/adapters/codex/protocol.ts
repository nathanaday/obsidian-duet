// Subset of the `codex app-server` v2 protocol that this adapter uses.
// Generate the full definitions with: codex app-server generate-ts --out <dir>

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface Thread {
  id: string;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface Turn {
  id: string;
  status: TurnStatus;
  error: { message: string; additionalDetails: string | null } | null;
}

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: ItemStatus;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: { path: string; kind: unknown; diff: string }[];
      status: ItemStatus;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: ItemStatus;
      error: { message: string } | null;
    }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: string; id: string };

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface AgentMessageDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TurnNotification {
  threadId: string;
  turn: Turn;
}

export interface ErrorNotification {
  threadId: string;
  turnId: string;
  willRetry: boolean;
  error: { message: string };
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface PermissionProfile {
  network: object | null;
  fileSystem: object | null;
}

export interface PermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: PermissionProfile;
}
