<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { QueuedMessage } from "@tanstack/ai-client";
import { DateTime, Option, type Schema } from "effect";
import { isString } from "../../../../src/schema";
import { attachedIn, dropKind, pastedImages, uriListPaths } from "../../../src/shared/attachments";
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
  turnsTrouble,
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
// Follows what arrives while the reader is near the bottom; scrolled up, it stays put.
const NEAR_BOTTOM = 80;
const list = ref<HTMLOListElement>();
let following = true;
const follow = () => {
  const at = list.value;
  if (at !== undefined) following = at.scrollHeight - at.scrollTop - at.clientHeight <= NEAR_BOTTOM;
};
const arrived = new MutationObserver(() => {
  if (following && list.value !== undefined) list.value.scrollTop = list.value.scrollHeight;
});
onMounted(() => {
  if (list.value !== undefined)
    arrived.observe(list.value, { childList: true, subtree: true, characterData: true });
});
onBeforeUnmount(() => arrived.disconnect());
const { chip, choose } = useChip();
const { popIn } = usePopOut();
const draft = ref("");
onMounted(reload);
const files = useAttachments();

/**
 * The message goes with the chip and the files, which it uses up; `now` pushes it past the
 * turn under way. Files need no words.
 */
const send = (now = false) => {
  const text = draft.value.trim();
  if (text === "" && files.pending.value.length === 0) return;
  draft.value = "";
  void say(text, chip.value, now, files.pending.value);
  choose(null);
  files.clear();
};

/**
 * A paste of files attaches them: files a file manager copied, by the URIs main reads, or
 * images. Anything else pastes as it always did, and a paste the webview handed nothing
 * at all asks the system clipboard.
 */
const pasted = (event: ClipboardEvent) => {
  const data = event.clipboardData;
  if (data === null) return;
  if (data.types.includes("text/uri-list")) {
    event.preventDefault();
    const { paths, refused } = uriListPaths(data.getData("text/uri-list"));
    void files.addPaths(paths, refused);
    return;
  }
  const items = [...data.items];
  const images = pastedImages(items).flatMap((at) => [items[at]?.getAsFile() ?? null]);
  if (images.length > 0) {
    event.preventDefault();
    for (const image of images) if (image !== null) void files.add(image, true);
  } else if (data.types.length === 0) void files.fromClipboard();
};

/** A drop attaches files, and never navigates the window. */
const dropped = (event: DragEvent) => {
  const data = event.dataTransfer;
  if (data === null) return;
  const kind = dropKind([...data.types]);
  if (kind === "text") return;
  event.preventDefault();
  if (kind === "uris") {
    const { paths, refused } = uriListPaths(data.getData("text/uri-list"));
    void files.addPaths(paths, refused);
  } else for (const file of data.files) void files.add(file, false);
};

/** The files a message part is, where it is one. */
const attachedOf = (part: { readonly type: string }) => Option.getOrNull(attachedIn(part));

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
const queuedText = ({ content }: QueuedMessage) => {
  const said = isString(content) ? content : content.content;
  return isString(said)
    ? said
    : said.flatMap((part) => (part.type === "text" ? [part.content] : [])).join(" ") || "files";
};
</script>

<template>
  <aside
    data-testid="flock-chat"
    class="flex h-full flex-col border-l border-default"
    @dragover.prevent
    @drop="dropped"
  >
    <header class="flex items-center gap-1 border-b border-default px-6 py-2">
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
    <ol
      ref="list"
      data-testid="chat-messages"
      class="flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-4"
      @scroll="follow"
    >
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
            <AttachmentChip
              v-else-if="attachedOf(part) !== null"
              :file="attachedOf(part)!"
              class="self-end"
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
      <li v-if="turnsTrouble">
        <RetryNotice title="Desktop is reconnecting to its chat" :trouble="turnsTrouble" />
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
    <p v-if="error" class="px-6 text-sm text-error">{{ error.message }}</p>
    <div v-if="chip !== null" class="px-6 pt-2">
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
    <div v-if="files.pending.value.length > 0" class="flex flex-wrap gap-2 px-6 pt-2">
      <AttachmentChip
        v-for="file in files.pending.value"
        :key="file.id"
        :file="file"
        removable
        @remove="files.remove(file.id)"
      />
    </div>
    <p v-if="files.refused.value" data-testid="chat-refused" class="px-6 pt-2 text-sm text-error">
      {{ files.refused.value }}
    </p>
    <form class="flex gap-2 border-t border-default px-6 py-3" @submit.prevent="send()">
      <UTextarea
        v-model="draft"
        data-testid="chat-input"
        class="flex-1"
        :rows="2"
        autoresize
        :placeholder="
          isLoading ? 'Enter queues it, Ctrl+Enter sends it now' : 'Ask about the Flock'
        "
        @keydown.enter.exact.prevent="send()"
        @keydown.ctrl.enter.exact.prevent="send(true)"
        @paste="pasted"
      />
      <UButton
        icon="i-lucide-paperclip"
        color="neutral"
        variant="ghost"
        aria-label="Attach files"
        title="Attach files"
        data-testid="chat-attach"
        @click="files.pick()"
      />
      <UButton type="submit" icon="i-lucide-send" aria-label="Send" />
    </form>
  </aside>
</template>
