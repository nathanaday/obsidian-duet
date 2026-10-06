<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Conversation from './components/Conversation.vue';
import EventLog from './components/EventLog.vue';
import Gem from './components/Gem.vue';
import SessionBar from './components/SessionBar.vue';
import SetupView from './components/SetupView.vue';
import { loadInfo, state } from './session.ts';

const logOpen = ref(false);
const loadError = ref<string>();

onMounted(() => {
  loadInfo().catch((error: Error) => {
    loadError.value = error.message;
  });
});
</script>

<template>
  <div class="shell" :class="{ 'has-session': state.session }">
    <header class="top">
      <div class="brand">
        <Gem :active="state.running" />
        <span class="wordmark">duet</span>
      </div>
      <SessionBar v-if="state.session" v-model:log-open="logOpen" />
    </header>

    <SetupView v-if="!state.session" :load-error="loadError" />

    <main v-else class="workspace" :class="{ 'log-open': logOpen }">
      <Conversation />
      <EventLog />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  height: 100%;
}

.top {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  min-height: 3.5rem;
  padding: 0 1.25rem;
  border-bottom: 1px solid var(--line);
}

.shell:not(.has-session) .top {
  border-bottom-color: transparent;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}

.wordmark {
  font-size: 1.12rem;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(20rem, 26rem);
  min-height: 0;
}

@media (max-width: 560px) {
  .top {
    gap: 0.9rem;
    padding: 0 0.75rem 0 1rem;
  }

  .has-session .wordmark {
    display: none;
  }
}

@media (max-width: 960px) {
  .workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace :deep(.event-log) {
    display: none;
  }

  .workspace.log-open {
    grid-template-rows: minmax(0, 1fr) minmax(0, 40%);
  }

  .workspace.log-open :deep(.event-log) {
    display: flex;
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}
</style>
