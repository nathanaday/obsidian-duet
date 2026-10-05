<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { WireEvent } from '../../server/protocol.ts';
import { type LogRow, state } from '../session.ts';

const scroller = ref<HTMLElement>();
const open = ref(new Set<number>());
const follow = ref(true);

const FAMILY: Record<WireEvent['type'], string> = {
  'turn-start': 'turn',
  'turn-end': 'turn',
  'text-delta': 'text',
  message: 'text',
  'tool-start': 'tool',
  'tool-end': 'tool',
  'permission-request': 'permission',
  'permission-resolved': 'permission',
  closed: 'closed',
};

function summary(row: LogRow): string {
  const event = row.event;
  switch (event.type) {
    case 'turn-start':
      return `“${event.prompt}”`;
    case 'text-delta': {
      const deltas = row.deltas!;
      return `${deltas.count} ${deltas.count === 1 ? 'chunk' : 'chunks'}, ${deltas.chars} characters`;
    }
    case 'message':
      return event.text;
    case 'tool-start':
      return event.title;
    case 'tool-end':
      return `${event.ok ? 'ok' : 'failed'}${event.output ? `: ${event.output.trim().split('\n')[0]}` : ''}`;
    case 'permission-request':
      return event.title;
    case 'permission-resolved':
      return event.decision;
    case 'turn-end':
      return event.result.error ? `${event.result.status}: ${event.result.error}` : event.result.status;
    case 'closed':
      return event.error ?? 'session closed';
  }
}

function time(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function payload(row: LogRow): string {
  if (row.event.type !== 'text-delta') return JSON.stringify(row.event, null, 2);
  return `${row.deltas!.count} text-delta events from ${time(row.at)} to ${time(row.deltas!.lastAt)}.\nThe conversation joins them into one message as they arrive.`;
}

function toggle(seq: number) {
  const next = new Set(open.value);
  if (!next.delete(seq)) next.add(seq);
  open.value = next;
}

function onScroll() {
  const element = scroller.value;
  if (element) follow.value = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
}

watch(
  () => [state.log.length, state.log.at(-1)?.deltas?.count],
  async () => {
    if (!follow.value) return;
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  },
);
</script>

<template>
  <aside class="event-log" aria-label="Events">
    <header>
      <h2>Events <span class="count">{{ state.log.length }}</span></h2>
      <p>What the session emits, in order. Select an event to see its data.</p>
    </header>
    <ol ref="scroller" class="rows" @scroll="onScroll">
      <li v-if="!state.log.length" class="waiting">Send a message to see the events of a turn.</li>
      <li v-for="row in state.log" :key="row.seq" class="row" :class="FAMILY[row.event.type]">
        <button type="button" :aria-expanded="open.has(row.seq)" @click="toggle(row.seq)">
          <span class="time">{{ time(row.at) }}</span>
          <span class="type">{{ row.event.type }}</span>
          <span class="summary">{{ summary(row) }}</span>
        </button>
        <pre v-if="open.has(row.seq)" class="payload">{{ payload(row) }}</pre>
      </li>
    </ol>
  </aside>
</template>

<style scoped>
.event-log {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--line);
  background: var(--surface);
}

header {
  padding: 1.1rem 1.1rem 0.8rem;
  border-bottom: 1px solid var(--line);
}

h2 {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0;
  font-size: 0.98rem;
  font-weight: 650;
}

.count {
  color: var(--muted);
  font-weight: 450;
  font-variant-numeric: tabular-nums;
}

header p {
  margin: 0.2rem 0 0;
  color: var(--muted);
  font-size: 0.82rem;
}

.rows {
  flex: 1;
  margin: 0;
  padding: 0.5rem 0;
  overflow-y: auto;
  list-style: none;
}

.waiting {
  padding: 0.6rem 1.1rem;
  color: var(--muted);
  font-size: 0.85rem;
}

.row button {
  display: grid;
  grid-template-columns: 3.8rem 10.6rem minmax(0, 1fr);
  min-width: 0;
  align-items: baseline;
  gap: 0.5rem;
  width: 100%;
  padding: 0.28rem 1.1rem;
  border: 0;
  background: none;
  text-align: left;
}

.row button:hover {
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}

.time {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.type {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-family: var(--mono);
  font-size: 0.74rem;
  font-weight: 500;
  white-space: nowrap;
}

.type::before {
  content: '';
  flex: none;
  width: 0.55rem;
  height: 0.55rem;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: var(--family);
}

.summary {
  overflow: hidden;
  color: var(--ink-soft);
  font-size: 0.8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.turn {
  --family: var(--ink);
}

.text {
  --family: #5fbf9c;
}

.tool {
  --family: var(--amber);
}

.permission {
  --family: var(--helenite);
}

.closed {
  --family: var(--rust);
}

.payload {
  margin: 0.15rem 1.1rem 0.6rem 4.3rem;
  overflow-x: auto;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--raised);
  color: var(--ink-soft);
  font-size: 0.72rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .row button {
    grid-template-columns: 3.4rem minmax(0, 1fr);
  }

  .summary {
    grid-column: 2;
  }

  .payload {
    margin-left: 1.1rem;
  }
}
</style>
