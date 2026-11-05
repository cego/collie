<script setup lang="ts">
/** This window is the chat's own, popped out of the board's, and opens no board of its own. */
const alone = window.location.hash === "#chat";
</script>

<template>
  <UApp>
    <template v-if="alone">
      <FlockChat alone class="h-screen border-l-0" />
      <StandingSetupDialog />
    </template>
    <FlockBoard v-else />
  </UApp>
</template>
