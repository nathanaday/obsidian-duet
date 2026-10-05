<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ApprovalSetting, Harness } from '../../server/protocol.ts';
import { start, state } from '../session.ts';

defineProps<{ loadError?: string }>();

const HARNESSES: { id: Harness; name: string; summary: string }[] = [
  { id: 'claude', name: 'Claude Code', summary: 'Anthropic’s agent, through the Claude Agent SDK.' },
  { id: 'codex', name: 'Codex', summary: 'OpenAI’s agent, through codex app-server.' },
];

const APPROVALS: Record<Harness, { id: ApprovalSetting; label: string; hint: string }[]> = {
  claude: [
    { id: 'ask', label: 'Ask before edits and commands', hint: 'Claude asks before it changes a file or runs a command that can change something.' },
    { id: 'accept-edits', label: 'Allow edits, ask before commands', hint: 'Claude edits files in the folder without asking.' },
    { id: 'plan', label: 'Plan only', hint: 'Claude reads and plans, but changes nothing.' },
  ],
  codex: [
    { id: 'ask', label: 'Ask before every command', hint: 'Codex asks before each command, except a few read-only ones.' },
    { id: 'sandbox', label: 'Ask only outside the sandbox', hint: 'Codex works freely inside the folder and asks when it needs more access.' },
  ],
};

const harness = ref<Harness>('claude');
const cwd = ref('');
const approval = ref<ApprovalSetting>('ask');
const userTools = ref(false);
const resume = ref('');
const showResume = ref(false);

watch(
  () => state.info,
  (info) => {
    if (info && !info.harnesses.claude.available && info.harnesses.codex.available) harness.value = 'codex';
  },
  { immediate: true },
);
watch(harness, () => (approval.value = 'ask'));

const usingSample = computed(() => !cwd.value.trim());
const approvalHint = computed(() => APPROVALS[harness.value].find((option) => option.id === approval.value)?.hint);
const canStart = computed(
  () => !state.starting && !!state.info?.harnesses[harness.value].available,
);

function submit() {
  if (!canStart.value) return;
  void start({
    harness: harness.value,
    cwd: cwd.value.trim(),
    approval: approval.value,
    userTools: userTools.value,
    resume: showResume.value ? resume.value.trim() || undefined : undefined,
  });
}
</script>

<template>
  <section class="setup">
    <div class="intro">
      <h1>Run a coding agent from your own interface.</h1>
      <p>
        helenite starts Claude Code or Codex as a background process and shows everything it does here: the reply as it
        streams, each tool it uses, and each action it wants your approval for. No terminal is involved.
      </p>
    </div>

    <p v-if="loadError" class="error">Could not reach the demo server: {{ loadError }}</p>

    <form class="form" @submit.prevent="submit">
      <fieldset class="harnesses">
        <legend>Agent</legend>
        <label v-for="option in HARNESSES" :key="option.id" class="harness" :class="{ selected: harness === option.id }">
          <input v-model="harness" class="visually-hidden" type="radio" name="harness" :value="option.id"
            :disabled="!state.info?.harnesses[option.id].available" />
          <span class="harness-name">{{ option.name }}</span>
          <span class="harness-summary">{{ option.summary }}</span>
          <span v-if="state.info && !state.info.harnesses[option.id].available" class="missing">
            Not installed. Install it and log in, then reload this page.
          </span>
        </label>
      </fieldset>

      <label class="field">
        <span class="label">Folder</span>
        <input v-model="cwd" class="path" type="text" spellcheck="false" autocomplete="off" placeholder="Sample vault" />
        <span class="hint">
          <template v-if="usingSample">Leave this empty to give each session a fresh copy of a small sample vault. Your own files stay as they are.</template>
          <template v-else>The agent works in this folder and can change its files.</template>
        </span>
      </label>

      <label class="field">
        <span class="label">Approvals</span>
        <select v-model="approval">
          <option v-for="option in APPROVALS[harness]" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
        <span class="hint">{{ approvalHint }}</span>
      </label>

      <label v-if="harness === 'claude'" class="check">
        <input v-model="userTools" type="checkbox" />
        <span>Load my MCP servers and plugins</span>
      </label>

      <div class="resume">
        <button v-if="!showResume" class="link" type="button" @click="showResume = true">Continue an earlier session</button>
        <label v-else class="field">
          <span class="label">Session id</span>
          <input v-model="resume" class="path" type="text" spellcheck="false" autocomplete="off"
            placeholder="Paste the id from an earlier session" />
        </label>
      </div>

      <div class="submit">
        <button class="button primary start" type="submit" :disabled="!canStart">
          {{ state.starting ? 'Starting…' : 'Start session' }}
        </button>
        <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
      </div>
    </form>
  </section>
</template>

<style scoped>
.setup {
  width: 100%;
  max-width: 38rem;
  margin: 0 auto;
  padding: clamp(1.5rem, 5vh, 3.5rem) 1.25rem 3rem;
  overflow-y: auto;
}

h1 {
  margin: 0 0 1rem;
  font-size: clamp(2rem, 4.4vw, 2.7rem);
  font-weight: 650;
  line-height: 1.04;
  letter-spacing: -0.035em;
  text-wrap: balance;
}

.intro p {
  max-width: 34rem;
  margin: 0 0 2rem;
  color: var(--ink-soft);
  font-size: 1.04rem;
  line-height: 1.6;
}

.form {
  display: grid;
  gap: 1.25rem;
}

fieldset {
  margin: 0;
  padding: 0;
  border: 0;
}

legend,
.label {
  display: block;
  margin-bottom: 0.45rem;
  font-weight: 600;
}

.harnesses {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.harnesses legend {
  grid-column: 1 / -1;
}

.harness {
  display: grid;
  align-content: start;
  gap: 0.2rem;
  padding: 0.9rem 1rem 1rem;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--raised);
  cursor: pointer;
  transition: border-color 120ms, box-shadow 120ms;
}

.harness:hover {
  border-color: var(--muted);
}

.harness.selected {
  border-color: var(--helenite);
  box-shadow: inset 0 0 0 1px var(--helenite);
}

.harness:has(input:focus-visible) {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.harness:has(input:disabled) {
  opacity: 0.6;
  cursor: default;
}

.harness-name {
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.harness-summary,
.hint {
  color: var(--muted);
  font-size: 0.88rem;
}

.missing {
  margin-top: 0.35rem;
  color: var(--rust);
  font-size: 0.85rem;
}

.field {
  display: grid;
}

.field input,
.field select {
  height: 2.6rem;
  padding: 0 0.75rem;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--raised);
}

.field input:focus-visible,
.field select:focus-visible {
  outline-offset: 0;
}

.path {
  font-family: var(--mono);
  font-size: 0.85rem;
}

.hint {
  margin-top: 0.4rem;
}

.check {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin-top: -0.4rem;
}

.check input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--helenite);
}

.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--helenite);
  font-weight: 550;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.submit {
  display: grid;
  gap: 0.75rem;
}

.start {
  justify-self: start;
  height: 2.75rem;
  padding: 0 1.4rem;
  font-size: 1rem;
}

.error {
  margin: 0;
  color: var(--rust);
  white-space: pre-wrap;
}

@media (max-width: 560px) {
  .harnesses {
    grid-template-columns: 1fr;
  }
}
</style>
