<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, nextTick, ref, watch } from 'vue';
import { interrupt, send, state } from '../session.ts';
import PermissionCard from './PermissionCard.vue';
import ToolRow from './ToolRow.vue';

const SUGGESTIONS = [
  'Summarize each note in this folder in one line.',
  'Add a “Next steps” section to Ideas.md with three ideas of your own.',
  'Collect the action items from the standup notes into a new note called Tasks.md.',
];

const draft = ref('');
const scroller = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
const stickToBottom = ref(true);

const agentName = computed(() => (state.session?.harness === 'codex' ? 'Codex' : 'Claude'));
const sendLabel = computed(() => (state.running ? 'Queue' : 'Send'));

function render(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));
}

async function submit(text = draft.value) {
  const message = text.trim();
  if (!message || state.ended) return;
  draft.value = '';
  stickToBottom.value = true;
  await send(message);
  await nextTick();
  resize();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
  if (event.key === 'Escape' && state.running) void interrupt();
}

function resize() {
  const element = input.value;
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
}

function onScroll() {
  const element = scroller.value;
  if (element) stickToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

watch(
  () => [state.queue.length, ...state.items.map((item) => (item.kind === 'agent' ? item.text.length : item.kind))].join(),
  async () => {
    if (!stickToBottom.value) return;
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  },
);
</script>

<template>
  <section class="conversation" aria-label="Conversation">
    <div ref="scroller" class="scroller" @scroll="onScroll">
      <div class="column">
        <div v-if="!state.items.length" class="empty">
          <p class="empty-lead">{{ agentName }} is ready. It works in <code>{{ state.session?.cwd }}</code>.</p>
          <p class="empty-hint">Try one of these, or write your own:</p>
          <ul class="suggestions">
            <li v-for="suggestion in SUGGESTIONS" :key="suggestion">
              <button type="button" @click="submit(suggestion)">{{ suggestion }}</button>
            </li>
          </ul>
        </div>

        <template v-for="item in state.items" :key="item.key">
          <div v-if="item.kind === 'user'" class="user">
            <p>{{ item.text }}</p>
          </div>

          <div v-else-if="item.kind === 'agent'" class="agent" :class="{ streaming: item.streaming }"
            v-html="render(item.text)" />

          <ToolRow v-else-if="item.kind === 'tool'" :item="item" />

          <PermissionCard v-else-if="item.kind === 'permission'" :item="item" :agent="agentName" />

          <p v-else-if="item.kind === 'notice'" class="notice" :class="item.tone">{{ item.text }}</p>
        </template>

        <div v-if="state.running" class="working" aria-live="polite">
          <span class="dots" aria-hidden="true"><i /><i /><i /></span>
          {{ agentName }} is working
        </div>

        <div v-for="entry in state.queue" :key="entry.key" class="user queued">
          <p>{{ entry.text }}</p>
          <span class="queued-label">Sends when the current turn ends</span>
        </div>
      </div>
    </div>

    <form class="composer" @submit.prevent="submit()">
      <div class="column">
        <p v-if="state.ended" class="ended">This session has ended. Use “End session” to start a new one.</p>
        <div v-else class="field">
          <label class="visually-hidden" for="message">Message</label>
          <textarea id="message" ref="input" v-model="draft" rows="1" :placeholder="`Message ${agentName}`"
            @input="resize" @keydown="onKeydown" />
          <div class="controls">
            <span class="keys">
              <template v-if="state.running"><kbd>Esc</kbd> stops the turn</template>
              <template v-else><kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line</template>
            </span>
            <span v-if="state.queue.length" class="queued-count">{{ state.queue.length }} waiting</span>
            <button v-if="state.running" class="button" type="button" @click="interrupt">Stop</button>
            <button class="button primary" type="submit" :disabled="!draft.trim()">{{ sendLabel }}</button>
          </div>
        </div>
      </div>
    </form>
  </section>
</template>

<style scoped>
.conversation {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  min-height: 0;
}

.scroller {
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.column {
  width: 100%;
  max-width: 46rem;
  margin: 0 auto;
  padding: 0 1.5rem;
}

.scroller .column {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding-top: 2rem;
  padding-bottom: 2rem;
}

.empty {
  padding-top: 8vh;
}

.empty-lead {
  margin: 0 0 0.4rem;
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.3;
}

.empty-lead code {
  font-size: 0.62em;
  font-weight: 400;
  color: var(--muted);
  word-break: break-all;
}

.empty-hint {
  margin: 1.5rem 0 0.6rem;
  color: var(--muted);
}

.suggestions {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.suggestions button {
  width: 100%;
  padding: 0.75rem 0.95rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--raised);
  text-align: left;
  transition: border-color 120ms;
}

.suggestions button:hover {
  border-color: var(--helenite);
}

.user {
  margin-top: 1.1rem;
  padding-left: 0.9rem;
  border-left: 3px solid var(--ink);
}

.user:first-child {
  margin-top: 0;
}

.user p {
  margin: 0;
  font-size: 1.06rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: pre-wrap;
}

.user.queued {
  border-left-color: var(--line-strong);
  color: var(--muted);
}

.queued-label {
  font-size: 0.82rem;
}

.agent {
  font-size: 0.99rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.agent :deep(> :first-child) {
  margin-top: 0;
}

.agent :deep(> :last-child) {
  margin-bottom: 0;
}

.agent :deep(p),
.agent :deep(ul),
.agent :deep(ol) {
  margin: 0 0 0.7rem;
}

.agent :deep(h1),
.agent :deep(h2),
.agent :deep(h3) {
  margin: 1.1rem 0 0.4rem;
  font-size: 1.02rem;
  letter-spacing: -0.01em;
}

.agent :deep(a) {
  color: var(--helenite);
  text-underline-offset: 2px;
}

.agent :deep(code) {
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--line);
}

.agent :deep(pre) {
  overflow-x: auto;
  padding: 0.8rem 1rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}

.agent :deep(pre code) {
  padding: 0;
  border: 0;
  background: none;
}

.agent.streaming :deep(> :last-child)::after {
  content: '';
  display: inline-block;
  width: 0.5em;
  height: 1em;
  margin-left: 0.15em;
  vertical-align: -0.15em;
  background: var(--helenite);
  animation: caret 1s steps(2) infinite;
}

@keyframes caret {
  50% {
    opacity: 0;
  }
}

.notice {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.notice.stopped::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--line);
}

.notice.error {
  padding: 0.7rem 0.9rem;
  border: 1px solid color-mix(in srgb, var(--rust) 40%, transparent);
  border-radius: 8px;
  color: var(--rust);
  white-space: pre-wrap;
}

.working {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--muted);
  font-size: 0.88rem;
}

.dots {
  display: inline-flex;
  gap: 0.2rem;
}

.dots i {
  width: 0.32rem;
  height: 0.32rem;
  border-radius: 50%;
  background: var(--helenite);
  animation: dot 1.2s ease-in-out infinite;
}

.dots i:nth-child(2) {
  animation-delay: 0.15s;
}

.dots i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes dot {
  0%,
  60%,
  100% {
    opacity: 0.25;
  }
  30% {
    opacity: 1;
  }
}

.composer {
  padding: 0 0 1.25rem;
}

.field {
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--raised);
  transition: border-color 120ms, box-shadow 120ms;
}

.field:focus-within {
  border-color: var(--helenite);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--helenite) 18%, transparent);
}

textarea {
  display: block;
  width: 100%;
  min-height: 3rem;
  padding: 0.85rem 1rem 0.4rem;
  border: 0;
  outline: none;
  background: none;
  resize: none;
  line-height: 1.5;
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.6rem 0.6rem 1rem;
}

.queued-count {
  color: var(--muted);
  font-size: 0.8rem;
}

.keys {
  flex: 1;
  color: var(--muted);
  font-size: 0.8rem;
}

kbd {
  padding: 0.05rem 0.3rem;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 0.74rem;
}

.ended {
  margin: 0;
  padding: 0.9rem 1rem;
  border: 1px dashed var(--line-strong);
  border-radius: 12px;
  color: var(--muted);
}

@media (max-width: 560px) {
  .column {
    padding: 0 1rem;
  }

  .keys {
    display: none;
  }

  .controls {
    justify-content: flex-end;
  }
}
</style>
