<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { PermissionDecision } from '../../server/protocol.ts';
import { decide, type Item } from '../session.ts';

const props = defineProps<{ item: Extract<Item, { kind: 'permission' }>; agent: string }>();

const card = ref<HTMLElement>();
const sending = ref(false);
const failure = ref<string>();

const action = computed(() => {
  switch (props.item.tool) {
    case 'Bash':
    case 'command':
      return 'run a command';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'fileChange':
      return 'change a file';
    case 'permissions':
      return 'get more access';
    default:
      return `use ${props.item.tool}`;
  }
});

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'fileChange']);

const showDetail = computed(() => !!props.item.detail && !props.item.title.includes(props.item.detail));

const lines = computed(() => {
  const isDiff = FILE_TOOLS.has(props.item.tool);
  return (props.item.detail ?? '').split('\n').map((text) => ({
    text,
    kind: !isDiff ? 'plain' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : text.startsWith('@@') ? 'hunk' : 'plain',
  }));
});

const outcome = computed(
  () =>
    ({
      allow: 'Allowed once',
      'allow-session': 'Allowed for this session',
      deny: 'Denied',
      cancelled: 'No longer needed',
      pending: '',
    })[props.item.state],
);

async function answer(decision: PermissionDecision) {
  if (sending.value || props.item.state !== 'pending') return;
  sending.value = true;
  failure.value = undefined;
  try {
    await decide(props.item.requestId, decision);
  } catch (error) {
    failure.value = (error as Error).message;
  } finally {
    sending.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const decision = ({ y: 'allow', a: 'allow-session', n: 'deny' } as const)[event.key.toLowerCase()];
  if (decision) {
    event.preventDefault();
    void answer(decision);
  }
}

onMounted(() => {
  if (props.item.state === 'pending') card.value?.focus({ preventScroll: true });
});
</script>

<template>
  <article v-if="item.state === 'pending'" ref="card" class="glass" tabindex="-1" aria-live="assertive"
    @keydown="onKeydown">
    <p class="ask">{{ agent }} wants to {{ action }}</p>
    <p class="title">{{ item.title }}</p>
    <pre v-if="showDetail" class="detail"><span v-for="(line, index) in lines" :key="index" class="line"
      :class="line.kind">{{ line.text || ' ' }}</span></pre>
    <div class="choices">
      <button type="button" class="choice allow" :disabled="sending" @click="answer('allow')">
        Allow once <kbd>Y</kbd>
      </button>
      <button type="button" class="choice" :disabled="sending" @click="answer('allow-session')">
        Allow for this session <kbd>A</kbd>
      </button>
      <button type="button" class="choice" :disabled="sending" @click="answer('deny')">Deny <kbd>N</kbd></button>
    </div>
    <p v-if="failure" class="failure">{{ failure }}</p>
  </article>

  <p v-else class="resolved" :class="item.state">
    <span class="mark" aria-hidden="true" />
    <span class="outcome">{{ outcome }}</span>
    <span class="what">{{ item.title }}</span>
  </p>
</template>

<style scoped>
.glass {
  position: relative;
  margin: 0.4rem 0;
  padding: 1.15rem 1.25rem 1.2rem;
  overflow: hidden;
  border-radius: 14px;
  background: linear-gradient(158deg, var(--glass-top) 0%, var(--glass-mid) 48%, var(--glass-bottom) 100%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.2),
    inset 0 0 0 1px rgb(255 255 255 / 0.06),
    0 18px 40px -22px rgb(8 64 47 / 0.75);
  color: var(--glass-text);
  outline: none;
  animation: rise 260ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.glass::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(115deg, transparent 38%, rgb(255 255 255 / 0.07) 46%, transparent 54%),
    linear-gradient(200deg, rgb(255 255 255 / 0.08), transparent 30%);
  pointer-events: none;
}

.glass:focus-visible {
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.2),
    0 0 0 3px var(--page),
    0 0 0 5px var(--focus);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.99);
  }
}

.ask {
  position: relative;
  margin: 0;
  color: var(--glass-soft);
  font-size: 0.9rem;
  font-weight: 550;
}

.title {
  position: relative;
  margin: 0.2rem 0 0;
  font-family: var(--mono);
  font-size: 0.95rem;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.detail {
  position: relative;
  max-height: 15rem;
  margin: 0.85rem 0 0;
  overflow: auto;
  padding: 0.6rem 0;
  border-radius: 8px;
  background: rgb(0 0 0 / 0.22);
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.25);
  font-size: 0.78rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.line {
  display: block;
  padding: 0 0.9rem;
}

.line.add {
  background: rgb(120 230 180 / 0.12);
  color: #a6f2cd;
}

.line.remove {
  background: rgb(240 140 120 / 0.12);
  color: #f6bcae;
}

.line.hunk {
  color: var(--glass-soft);
  opacity: 0.7;
}

.choices {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1rem;
}

.choice {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  height: 2.2rem;
  padding: 0 0.85rem;
  border: 1px solid rgb(255 255 255 / 0.22);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.06);
  color: var(--glass-text);
  font-weight: 550;
  transition: background-color 120ms, border-color 120ms;
}

.choice:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.14);
  border-color: rgb(255 255 255 / 0.36);
}

.choice.allow {
  border-color: transparent;
  background: var(--glass-text);
  color: var(--glass-bottom);
}

.choice.allow:hover:not(:disabled) {
  background: #fff;
}

.choice:focus-visible {
  outline-color: #fff;
}

.choice kbd {
  padding: 0 0.3rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 0.7rem;
  opacity: 0.6;
}

.failure {
  position: relative;
  margin: 0.75rem 0 0;
  color: #ffd2c7;
  font-size: 0.85rem;
}

.resolved {
  display: flex;
  align-items: baseline;
  gap: 0.55rem;
  margin: 0;
  font-size: 0.86rem;
  animation: settle 220ms ease-out;
}

@keyframes settle {
  from {
    opacity: 0;
  }
}

.mark {
  flex: none;
  align-self: center;
  width: 0.7rem;
  height: 0.7rem;
  margin-left: 0.5rem;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: var(--accent);
}

.resolved.deny .mark,
.resolved.cancelled .mark {
  background: var(--line-strong);
}

.outcome {
  font-weight: 600;
  white-space: nowrap;
}

.deny .outcome {
  color: var(--rust);
}

.what {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
