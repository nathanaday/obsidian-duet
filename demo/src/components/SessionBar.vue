<script setup lang="ts">
import { computed, ref } from 'vue';
import { leave, state } from '../session.ts';

const logOpen = defineModel<boolean>('logOpen', { default: false });
const copied = ref(false);

const harnessName = computed(() => (state.session?.harness === 'codex' ? 'Codex' : 'Claude Code'));
const folder = computed(() => state.session?.cwd.split('/').filter(Boolean).at(-1) ?? '');
const status = computed(() => (state.ended ? 'Ended' : state.running ? 'Working' : 'Ready'));

async function copyId() {
  if (!state.session) return;
  await navigator.clipboard.writeText(state.session.id);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1400);
}
</script>

<template>
  <div v-if="state.session" class="bar">
    <div class="facts">
      <span class="harness">{{ harnessName }}</span>
      <span class="folder" :title="state.session.cwd">{{ folder }}</span>
      <button class="id" type="button" :title="`Copy session id ${state.session.id}`" @click="copyId">
        {{ copied ? 'Copied' : state.session.id.slice(0, 8) }}
      </button>
    </div>
    <span class="status" :class="status.toLowerCase()" role="status">{{ status }}</span>
    <div class="actions">
      <button class="button quiet log-toggle" type="button" :aria-pressed="logOpen" @click="logOpen = !logOpen">
        Events
      </button>
      <button class="button quiet" type="button" @click="leave">End session</button>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 1rem;
  min-width: 0;
}

.facts {
  display: flex;
  align-items: baseline;
  gap: 0.85rem;
  min-width: 0;
}

.harness {
  font-weight: 600;
  white-space: nowrap;
}

.folder {
  overflow: hidden;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.id {
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: none;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.78rem;
}

.id:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--muted);
  font-size: 0.85rem;
}

.status::before {
  content: '';
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--helenite);
}

.status.working::before {
  animation: pulse 1.2s ease-in-out infinite;
}

.status.ended::before {
  background: var(--line-strong);
}

@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}

.actions {
  display: flex;
  gap: 0.25rem;
  margin-left: auto;
}

.log-toggle {
  display: none;
}

.log-toggle[aria-pressed='true'] {
  color: var(--ink);
  border-color: var(--line);
}

@media (max-width: 960px) {
  .log-toggle {
    display: inline-flex;
  }

  .folder,
  .id {
    display: none;
  }
}

@media (max-width: 560px) {
  .bar {
    gap: 0.6rem;
  }

  .status {
    font-size: 0;
  }

  .actions .button {
    padding: 0 0.55rem;
  }
}
</style>
