<script setup lang="ts">
defineProps<{ active?: boolean }>();
</script>

<template>
  <svg class="gem" :class="{ active }" viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
    <path d="M16 2 28 9v14l-12 7L4 23V9z" fill="#0e6b50" />
    <path class="facet" d="M16 2 28 9l-12 7z" fill="#1b8f6b" />
    <path d="M4 9l12 7v14L4 23z" fill="#08402f" />
    <path d="M16 16 28 9v14l-12 7z" fill="#0b5a43" />
  </svg>
</template>

<style scoped>
.facet {
  transition: fill 300ms;
}

.active .facet {
  animation: glint 1.6s ease-in-out infinite;
}

@keyframes glint {
  50% {
    fill: #5fd3a8;
  }
}
</style>
