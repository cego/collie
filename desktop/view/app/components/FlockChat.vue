<script setup lang="ts">
import { Markdown } from "@comark/vue";

const { messages, sendMessage, isLoading, error } = useFlockChat();
const draft = ref("");

const send = () => {
  const text = draft.value.trim();
  if (text === "" || isLoading.value) return;
  draft.value = "";
  void sendMessage(text);
};
</script>

<template>
  <aside data-testid="flock-chat" class="flex h-full flex-col border-l border-default">
    <header class="flex items-center gap-2 border-b border-default px-4 py-3">
      <UIcon name="i-lucide-messages-square" class="size-4 text-primary" />
      <strong class="text-sm">Flock chat</strong>
    </header>
    <ol class="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      <li
        v-for="message in messages"
        :key="message.id"
        :data-testid="`chat-${message.role}`"
        :class="message.role === 'user' ? 'self-end rounded-md bg-elevated px-3 py-2' : ''"
      >
        <template v-for="(part, at) in message.parts" :key="at">
          <Markdown
            v-if="part.type === 'text'"
            :value="part.content"
            :streaming="isLoading && message === messages.at(-1)"
            class="prose prose-sm dark:prose-invert"
          />
          <p v-else-if="part.type === 'tool-call'" class="text-xs text-muted">
            <UIcon name="i-lucide-wrench" class="size-3" />
            {{ part.name.replace(/^mcp__collie__/, "") }}
          </p>
        </template>
      </li>
    </ol>
    <p v-if="error" class="px-4 text-sm text-error">{{ error.message }}</p>
    <form class="flex gap-2 border-t border-default p-3" @submit.prevent="send">
      <UTextarea
        v-model="draft"
        data-testid="chat-input"
        class="flex-1"
        :rows="2"
        autoresize
        placeholder="Ask about the Flock"
        @keydown.enter.exact.prevent="send"
      />
      <UButton type="submit" icon="i-lucide-send" :loading="isLoading" aria-label="Send" />
    </form>
  </aside>
</template>
