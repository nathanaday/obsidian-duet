<script setup lang="ts">
import { computed } from 'vue';
import type { Item } from '../session.ts';

const props = defineProps<{ item: Extract<Item, { kind: 'tool' }> }>();

const toolName = computed(() =>
  ({ commandExecution: 'Shell', fileChange: 'Edit', mcpToolCall: 'MCP', webSearch: 'Search' })[props.item.tool] ??
  props.item.tool,
);
const label = computed(() => {
  const { tool, title } = props.item;
  for (const prefix of [`${tool} `, `${toolName.value} `]) {
    if (title.startsWith(prefix)) return title.slice(prefix.length);
  }
  return title;
});
const stateLabel = computed(() => ({ running: 'Running', ok: 'Done', failed: 'Failed' })[props.item.state]);
</script>

<template>
  <details class="tool" :class="item.state">
    <summary>
      <span class="glyph" :aria-label="stateLabel" role="img" />
      <span class="name">{{ toolName }}</span>
      <span class="label">{{ label }}</span>
    </summary>
    <pre v-if="item.output" class="output">{{ item.output.trim() }}</pre>
    <p v-else class="output empty">{{ item.state === 'running' ? 'No output yet.' : 'No output.' }}</p>
  </details>
</template>

<style scoped>
.tool {
  font-size: 0.86rem;
}

summary {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: fit-content;
  max-width: 100%;
  padding: 0.3rem 0.6rem 0.3rem 0.5rem;
  border-radius: 6px;
  color: var(--ink-soft);
  list-style: none;
  cursor: pointer;
}

summary::-webkit-details-marker {
  display: none;
}

summary:hover {
  background: var(--surface);
}

.glyph {
  flex: none;
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
  border: 1.5px solid var(--helenite);
}

.running .glyph {
  border-right-color: transparent;
  animation: spin 0.8s linear infinite;
}

.ok .glyph {
  background: var(--helenite);
}

.failed .glyph {
  border-color: var(--rust);
  background: var(--rust);
}

@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}

.name {
  font-weight: 600;
}

.label {
  overflow: hidden;
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.failed .label {
  color: var(--rust);
}

.output {
  max-height: 16rem;
  margin: 0.35rem 0 0.4rem 1.3rem;
  overflow: auto;
  padding: 0.7rem 0.9rem;
  border-left: 2px solid var(--line);
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 0.78rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.output.empty {
  color: var(--muted);
  font-family: var(--sans);
}
</style>
