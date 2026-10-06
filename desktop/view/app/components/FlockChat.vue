<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { QueuedMessage } from "@tanstack/ai-client";
import { DateTime, type Schema } from "effect";
import { isString } from "../../../../src/schema";
import { aboutLine, DESKTOP_SAID, questionsOf } from "../../../src/shared/chat-view";

defineProps<{ alone?: boolean }>();
const emit = defineEmits<{ popOut: []; collapse: [] }>();

const {
  messages,
  queue,
  cancelQueued,
  isLoading,
  error,
  say,
  answer,
  reload,
  conversations,
  reopen,
  desktopSpeaking,
  proactive,
  setProactive,
} = useFlockChat();

type Message = (typeof messages.value)[number];
/** What Desktop said of its own about News, after its first line, or null for anyone else's message. */
const desktopSaid = (message: Message) => {
  const first = message.parts[0];
  return message.role === "user" && first?.type === "text" && first.content.startsWith(DESKTOP_SAID)
    ? first.content.slice(DESKTOP_SAID.length).trim()
    : null;
};
const { chip, choose } = useChip();
const { popIn } = usePopOut();
const draft = ref("");
onMounted(reload);

/** The message goes with the chip, which it uses up. */
const send = () => {
  const text = draft.value.trim();
  if (text === "") return;
  draft.value = "";
  void say(text, chip.value);
  choose(null);
};

const earlier = ref<DropdownMenuItem[]>([]);
const listEarlier = async (open: boolean) => {
  if (!open) return;
  const listed = await conversations();
  earlier.value =
    listed === null || listed.earlier.length === 0
      ? [{ label: "No earlier conversations", disabled: true }]
      : listed.earlier.map(({ session, title, at }) => ({
          label: title,
          description: DateTime.format(DateTime.makeUnsafe(at), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
          onSelect: () => void reopen(session),
        }));
};

const outputOf = (output: Schema.Json | undefined) =>
  output === undefined ? null : isString(output) ? output : JSON.stringify(output, null, 2);
const queuedText = ({ content }: QueuedMessage) => (isString(content) ? content : "…");
</script>

<template>
  <aside data-testid="flock-chat" class="flex h-full flex-col border-l border-default">
    <header class="flex items-center gap-1 border-b border-default px-4 py-2">
      <UIcon name="i-lucide-messages-square" class="size-4 text-primary" />
      <strong class="mr-auto ml-1 text-sm">Flock chat</strong>
      <UButton
        icon="i-lucide-square-pen"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Start fresh"
        title="Start fresh"
        data-testid="chat-fresh"
        @click="reopen(null)"
      />
      <UButton
        :icon="proactive ? 'i-lucide-bell' : 'i-lucide-bell-off'"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="proactive ? 'Speaks first about News that matters' : 'Waits to be asked'"
        :title="proactive ? 'Speaks first about News that matters' : 'Waits to be asked'"
        data-testid="chat-proactive"
        @click="setProactive(!proactive)"
      />
      <UDropdownMenu :items="earlier" :content="{ align: 'end' }" @update:open="listEarlier">
        <UButton
          icon="i-lucide-history"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Earlier conversations"
          title="Earlier conversations"
          data-testid="chat-history"
        />
      </UDropdownMenu>
      <UButton
        v-if="alone"
        icon="i-lucide-panel-right"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Put back beside the board"
        title="Put back beside the board"
        data-testid="chat-pop-in"
        :disabled="isLoading"
        @click="popIn()"
      />
      <template v-else>
        <UButton
          icon="i-lucide-external-link"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Pop out"
          title="Pop out"
          data-testid="chat-pop-out"
          :disabled="isLoading"
          @click="emit('popOut')"
        />
        <UButton
          icon="i-lucide-panel-right-close"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Hide the chat"
          title="Hide the chat"
          @click="emit('collapse')"
        />
      </template>
    </header>
    <ol class="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      <template v-for="message in messages" :key="message.id">
        <li
          v-if="desktopSaid(message) !== null"
          data-testid="chat-desktop"
          class="flex flex-col gap-1 rounded-md border border-default px-3 py-2 text-sm"
        >
          <UBadge class="self-start" size="sm" color="neutral" variant="subtle" label="Desktop" />
          <RichMarkdown
            :text="desktopSaid(message) ?? ''"
            class="prose prose-sm dark:prose-invert"
          />
        </li>
        <li
          v-else
          :data-testid="`chat-${message.role}`"
          class="flex flex-col gap-2"
          :class="message.role === 'user' ? 'self-end rounded-md bg-elevated px-3 py-2' : ''"
        >
          <template v-for="(part, at) in message.parts" :key="at">
            <RichMarkdown
              v-if="part.type === 'text'"
              :text="part.content"
              :streaming="isLoading && message === messages.at(-1)"
              class="prose prose-sm dark:prose-invert"
            />
            <details v-else-if="part.type === 'thinking'" data-testid="chat-thinking">
              <summary class="cursor-pointer text-xs text-muted">Thinking</summary>
              <p class="mt-1 text-xs whitespace-pre-wrap text-muted">{{ part.content }}</p>
            </details>
            <template v-else-if="part.type === 'tool-call'">
              <ChatQuestion
                v-if="
                  part.name === 'AskUserQuestion' &&
                  part.output === undefined &&
                  isLoading &&
                  questionsOf(part.arguments).length > 0
                "
                :args="part.arguments"
                @answer="answer(part.id, $event)"
              />
              <ChatToolRow
                v-else
                :name="part.name"
                :args="part.arguments"
                :output="outputOf(part.output)"
                :running="isLoading"
              />
            </template>
          </template>
        </li>
      </template>
      <li
        v-if="desktopSpeaking"
        data-testid="chat-desktop-speaking"
        class="flex items-center gap-2 text-sm text-muted"
      >
        <UBadge size="sm" color="neutral" variant="subtle" label="Desktop" />
        <span>is telling the chat what it noticed…</span>
      </li>
      <li
        v-for="pending in queue"
        :key="pending.id"
        data-testid="chat-queued"
        class="flex items-center gap-2 self-end rounded-md border border-dashed border-default px-3 py-2 text-muted"
      >
        <span class="whitespace-pre-wrap">{{ queuedText(pending) }}</span>
        <UBadge size="sm" color="neutral" variant="subtle" label="Queued" />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Don't send"
          @click="cancelQueued(pending.id)"
        />
      </li>
    </ol>
    <p v-if="error" class="px-4 text-sm text-error">{{ error.message }}</p>
    <div v-if="chip !== null" class="px-3 pt-2">
      <UBadge data-testid="chat-chip" color="primary" variant="subtle" class="max-w-full gap-1">
        <span class="truncate">About: {{ aboutLine(chip) }}</span>
        <UButton
          icon="i-lucide-x"
          color="primary"
          variant="link"
          size="xs"
          aria-label="Clear"
          data-testid="chat-chip-clear"
          @click="choose(null)"
        />
      </UBadge>
    </div>
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
      <UButton type="submit" icon="i-lucide-send" aria-label="Send" />
    </form>
  </aside>
</template>
