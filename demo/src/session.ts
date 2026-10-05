import { reactive } from 'vue';
import type {
  DemoInfo,
  Envelope,
  PermissionDecision,
  SessionInfo,
  StartRequest,
  WireEvent,
} from '../server/protocol.ts';

export type Item =
  | { kind: 'user'; key: number; text: string }
  | { kind: 'agent'; key: number; text: string; streaming: boolean }
  | { kind: 'tool'; key: number; id: string; tool: string; title: string; state: 'running' | 'ok' | 'failed'; output?: string }
  | {
      kind: 'permission';
      key: number;
      requestId: string;
      tool: string;
      title: string;
      detail?: string;
      state: PermissionDecision | 'pending' | 'cancelled';
    }
  | { kind: 'notice'; key: number; tone: 'stopped' | 'error'; text: string };

/** One row in the event log. Consecutive text deltas share a row. */
export interface LogRow {
  seq: number;
  at: number;
  event: WireEvent;
  deltas?: { count: number; chars: number; lastAt: number };
}

interface State {
  info: DemoInfo | undefined;
  session: SessionInfo | undefined;
  starting: boolean;
  error: string | undefined;
  items: Item[];
  /** Messages sent during a turn. Each one moves into `items` when its turn starts. */
  queue: { key: number; text: string }[];
  log: LogRow[];
  running: boolean;
  ended: boolean;
}

export const state = reactive<State>({
  info: undefined,
  session: undefined,
  starting: false,
  error: undefined,
  items: [],
  queue: [],
  log: [],
  running: false,
  ended: false,
});

let nextKey = 0;
let source: EventSource | undefined;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  return payload as T;
}

export async function loadInfo(): Promise<void> {
  state.info = await api<DemoInfo>('GET', '/info');
}

export async function start(request: StartRequest): Promise<void> {
  state.starting = true;
  state.error = undefined;
  try {
    const session = await api<SessionInfo>('POST', '/sessions', request);
    Object.assign(state, { session, items: [], queue: [], log: [], running: false, ended: false });
    connect(session.id);
  } catch (error) {
    state.error = (error as Error).message;
  } finally {
    state.starting = false;
  }
}

export async function send(text: string): Promise<void> {
  if (!state.session) return;
  const queued = { key: nextKey++, text };
  state.queue.push(queued);
  try {
    await api('POST', `/sessions/${state.session.id}/messages`, { text });
  } catch (error) {
    state.queue = state.queue.filter((entry) => entry !== queued);
    state.items.push({ kind: 'notice', key: nextKey++, tone: 'error', text: (error as Error).message });
  }
}

export async function interrupt(): Promise<void> {
  if (state.session) await api('POST', `/sessions/${state.session.id}/interrupt`);
}

export async function decide(requestId: string, decision: PermissionDecision): Promise<void> {
  if (state.session) await api('POST', `/sessions/${state.session.id}/permissions/${requestId}`, { decision });
}

/** Closes the session and returns to setup. */
export async function leave(): Promise<void> {
  const session = state.session;
  source?.close();
  source = undefined;
  Object.assign(state, { session: undefined, items: [], queue: [], log: [], running: false, ended: false });
  if (session) await api('DELETE', `/sessions/${session.id}`).catch(() => undefined);
}

function connect(id: string): void {
  source?.close();
  source = new EventSource(`/api/sessions/${id}/events`);
  let lastSeq = -1;
  source.onmessage = (message) => {
    const envelope = JSON.parse(message.data) as Envelope;
    // The server replays the whole log when the stream reconnects.
    if (envelope.seq <= lastSeq) return;
    lastSeq = envelope.seq;
    record(envelope);
    apply(envelope.event);
  };
}

function record({ seq, at, event }: Envelope): void {
  const last = state.log.at(-1);
  if (event.type === 'text-delta' && last?.event.type === 'text-delta' && last.deltas) {
    last.deltas.count += 1;
    last.deltas.chars += event.text.length;
    last.deltas.lastAt = at;
    return;
  }
  const row: LogRow = { seq, at, event };
  if (event.type === 'text-delta') row.deltas = { count: 1, chars: event.text.length, lastAt: at };
  state.log.push(row);
}

function lastAgent(): Extract<Item, { kind: 'agent' }> | undefined {
  const last = state.items.at(-1);
  return last?.kind === 'agent' && last.streaming ? last : undefined;
}

function apply(event: WireEvent): void {
  switch (event.type) {
    case 'turn-start': {
      state.running = true;
      const queued = state.queue[0]?.text === event.prompt ? state.queue.shift() : undefined;
      state.items.push({ kind: 'user', key: queued?.key ?? nextKey++, text: event.prompt });
      break;
    }
    case 'text-delta': {
      const agent = lastAgent();
      if (agent) agent.text += event.text;
      else state.items.push({ kind: 'agent', key: nextKey++, text: event.text, streaming: true });
      break;
    }
    case 'message': {
      const agent = lastAgent();
      if (agent) Object.assign(agent, { text: event.text, streaming: false });
      else state.items.push({ kind: 'agent', key: nextKey++, text: event.text, streaming: false });
      break;
    }
    case 'tool-start':
      state.items.push({ kind: 'tool', key: nextKey++, id: event.id, tool: event.tool, title: event.title, state: 'running' });
      break;
    case 'tool-end': {
      const tool = state.items.find((item) => item.kind === 'tool' && item.id === event.id);
      if (tool?.kind === 'tool') Object.assign(tool, { state: event.ok ? 'ok' : 'failed', output: event.output });
      break;
    }
    case 'permission-request':
      state.items.push({ kind: 'permission', key: nextKey++, ...event, state: 'pending' });
      break;
    case 'permission-resolved': {
      const card = state.items.find((item) => item.kind === 'permission' && item.requestId === event.requestId);
      if (card?.kind === 'permission') card.state = event.decision;
      break;
    }
    case 'turn-end': {
      state.running = false;
      for (const item of state.items) {
        if (item.kind === 'agent') item.streaming = false;
        if (item.kind === 'tool' && item.state === 'running') item.state = 'failed';
      }
      const { status, error } = event.result;
      if (status === 'interrupted') state.items.push({ kind: 'notice', key: nextKey++, tone: 'stopped', text: 'Stopped' });
      if (status === 'failed') state.items.push({ kind: 'notice', key: nextKey++, tone: 'error', text: error ?? 'The turn failed.' });
      break;
    }
    case 'closed':
      state.running = false;
      state.ended = true;
      state.queue = [];
      if (event.error) state.items.push({ kind: 'notice', key: nextKey++, tone: 'error', text: event.error });
      source?.close();
      break;
  }
}
