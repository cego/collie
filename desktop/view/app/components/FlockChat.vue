<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { QueuedMessage } from "@tanstack/ai-client";
import { DateTime, Option, type Schema } from "effect";
import { isString } from "../../../../src/schema";
import { attachedIn, dropKind, pastedImages, uriListPaths } from "../../../src/shared/attachments";
import {
  aboutLine,
  announcement,
  DESKTOP_SAID,
  earlierMenu,
  type Heard,
  putBack,
  questionsOf,
  submitButton,
} from "../../../src/shared/chat-view";
import { DEFAULT_CHAT_HARNESS } from "../../../src/shared/flock-settings";
import type { ChatChoice } from "../composables/useChatChoices";

defineProps<{ alone?: boolean }>();
const emit = defineEmits<{ popOut: []; collapse: [] }>();

const {
  messages,
  queue,
  cancelQueued,
  isLoading,
  status,
  stop,
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
const { openRecord } = useRecordOpener();
const toast = useToast();
const goneFromBoard = () =>
  toast.add({ title: "That Task is no longer on the board", color: "warning" });

type Message = (typeof messages.value)[number];
/** What Desktop said of its own about News, after its first line, or null for anyone else's message. */
const desktopSaid = (message: Message) => {
  const first = message.parts[0];
  return message.role === "user" && first?.type === "text" && first.content.startsWith(DESKTOP_SAID)
    ? first.content.slice(DESKTOP_SAID.length).trim()
    : null;
};
/** A message's markdown, with no margin above its first block or below its last. */
const PROSE =
  "prose prose-sm dark:prose-invert [&_.comark-content>:first-child]:mt-0 [&_.comark-content>:last-child]:mb-0";

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
const input = ref<{ textareaRef?: HTMLTextAreaElement | null }>();
const { selects, notice, refused, dismiss, choose: save, stay } = useChatChoices();
// Hoisted, with UAlert's own color and variant: the close button's props type omits the
// attributes Nuxt UI passes through.
const DISMISS = {
  color: "neutral" as const,
  variant: "link" as const,
  "aria-label": "Dismiss",
  title: "Dismiss",
};
const backToInput = () => input.value?.textareaRef?.focus();
/** Saves a choice at once, then puts the human back in the message box. */
const chooseChat = (which: ChatChoice, value: string) => void save(which, value).then(backToInput);
const stayHere = () => void stay().then(backToInput);
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

const button = computed(() => submitButton(status.value));
const replying = computed(() => button.value.status !== "ready");
const stopped = ref(false);
watch(replying, (now) => {
  if (now) stopped.value = false;
});
/** Puts the queue back into the message box, which the client discards on stop, then stops. */
const stopReply = () => {
  const back = putBack(queue.value, draft.value, chip.value);
  draft.value = back.draft;
  files.restore(back.files);
  if (back.chip !== chip.value) choose(back.chip);
  stopped.value = true;
  stop();
};
const heard = computed((): Heard => ({
  replying: replying.value,
  stopped: stopped.value,
  notice: notice.value?.said ?? null,
}));
const said = ref("");
watch(heard, (now, was) => {
  said.value = announcement(was, now) ?? said.value;
});

/** The files a message part is, where it is one. */
const attachedOf = (part: { readonly type: string }) => Option.getOrNull(attachedIn(part));

const { desktopSettings } = useDesktopSettings();
/** Makes that conversation current, or a fresh one; a refusal is told, and nothing changes. */
const open = async (earlier: { session: string; harness: string } | null) => {
  const refused = await reopen(earlier);
  if (refused !== null) toast.add({ title: refused, color: "error" });
};
const earlier = ref<DropdownMenuItem[][]>([]);
const listEarlier = async (opened: boolean) => {
  if (!opened) return;
  const listed = await conversations();
  if (listed === null || listed.earlier.length === 0) {
    earlier.value = [[{ label: "No earlier conversations", disabled: true }]];
    return;
  }
  const { entries, moves } = earlierMenu(
    listed,
    desktopSettings.value.chatHarness ?? DEFAULT_CHAT_HARNESS,
  );
  earlier.value = [
    entries.map(({ session, harness, title, at, label }) => ({
      label: title,
      description: DateTime.format(DateTime.makeUnsafe(at), {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      harness: label,
      onSelect: () => void open({ session, harness }),
    })),
    ...(moves === null ? [] : [[{ type: "label" as const, label: moves }]]),
  ];
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
        @click="open(null)"
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
        <template #item-description="{ item }">
          <span class="flex items-center gap-1.5">
            {{ item.description }}
            <UBadge
              v-if="item.harness"
              size="sm"
              color="neutral"
              variant="outline"
              :label="item.harness"
            />
          </span>
        </template>
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
      role="log"
      :aria-busy="replying"
      data-testid="chat-messages"
      class="flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-4"
      @scroll="follow"
    >
      <template v-for="message in messages" :key="message.id">
        <li
          v-if="desktopSaid(message) !== null"
          data-testid="chat-desktop"
          class="flex max-w-full min-w-0 flex-col gap-1 rounded-md border border-default px-3 py-2 text-sm"
        >
          <UBadge class="self-start" size="sm" color="neutral" variant="subtle" label="Desktop" />
          <RichMarkdown :text="desktopSaid(message) ?? ''" :class="PROSE" />
        </li>
        <li
          v-else
          :data-testid="`chat-${message.role}`"
          class="flex max-w-full min-w-0 flex-col gap-2"
          :class="message.role === 'user' ? 'self-end rounded-md bg-elevated px-3 py-2' : ''"
        >
          <UBadge
            v-if="aboutOf(message) !== null"
            as="button"
            type="button"
            data-testid="chat-about"
            color="neutral"
            variant="subtle"
            class="max-w-full cursor-pointer self-start"
            :title="aboutLine(aboutOf(message)!)"
            @click="openRecord(aboutOf(message)!, goneFromBoard)"
          >
            <span class="truncate">{{ aboutLine(aboutOf(message)!) }}</span>
          </UBadge>
          <template v-for="(part, at) in message.parts" :key="at">
            <RichMarkdown
              v-if="part.type === 'text'"
              :text="part.content"
              :streaming="isLoading && message === messages.at(-1)"
              :class="PROSE"
            />
            <AttachmentChip
              v-else-if="attachedOf(part) !== null"
              :file="attachedOf(part)!"
              class="self-end"
            />
            <details v-else-if="part.type === 'thinking'" data-testid="chat-thinking">
              <summary class="cursor-pointer text-xs text-muted">Thinking</summary>
              <p
                class="mt-1 text-xs whitespace-pre-wrap text-muted wrap-anywhere"
                v-text="part.content"
              />
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
        class="flex max-w-full min-w-0 items-center gap-2 self-end rounded-md border border-dashed border-default px-3 py-2 text-muted"
      >
        <span class="min-w-0 whitespace-pre-wrap wrap-anywhere">{{ queuedText(pending) }}</span>
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
    <p v-if="error" class="px-6 text-sm text-error wrap-anywhere">{{ error.message }}</p>
    <UAlert
      v-if="refused !== null"
      role="alert"
      data-testid="chat-choice-refused"
      class="mx-6 mt-2 w-auto"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="refused"
      :close="DISMISS"
      @update:open="dismiss()"
    />
    <UAlert
      v-if="notice?.kind === 'switch'"
      data-testid="chat-switch-notice"
      class="mx-6 mt-2 w-auto"
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      orientation="horizontal"
      :description="notice.said"
      :actions="[
        {
          label: notice.stay,
          icon: 'i-lucide-undo-2',
          color: 'info',
          variant: 'outline',
          onClick: stayHere,
        },
      ]"
    />
    <UAlert
      v-else-if="notice?.kind === 'reply'"
      data-testid="chat-reply-notice"
      class="mx-6 mt-2 w-auto"
      color="neutral"
      variant="subtle"
      icon="i-lucide-clock"
    >
      <template #description>
        This reply finishes on <strong>{{ notice.finishes }}</strong
        >. Your next message runs on <strong>{{ notice.next }}</strong
        >.
      </template>
    </UAlert>
    <form class="px-6 py-3" @submit.prevent="send()">
      <UChatPrompt
        ref="input"
        v-model="draft"
        as="div"
        variant="outline"
        data-testid="chat-input"
        :rows="2"
        :autofocus="false"
        :submit-on-enter="false"
        :placeholder="
          isLoading ? 'Enter queues it, Ctrl+Enter sends it now' : 'Ask about the Flock'
        "
        :ui="{ header: 'flex-wrap', footer: 'flex-wrap' }"
        @keydown.enter.exact.prevent="send()"
        @keydown.ctrl.enter.exact.prevent="send(true)"
        @paste="pasted"
      >
        <template
          v-if="chip !== null || files.pending.value.length > 0 || files.refused.value"
          #header
        >
          <UBadge
            v-if="chip !== null"
            data-testid="chat-chip"
            color="primary"
            variant="subtle"
            class="max-w-full gap-1"
          >
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
          <AttachmentChip
            v-for="file in files.pending.value"
            :key="file.id"
            :file="file"
            removable
            @remove="files.remove(file.id)"
          />
          <p
            v-if="files.refused.value"
            role="alert"
            data-testid="chat-refused"
            class="w-full text-sm text-error"
          >
            {{ files.refused.value }}
          </p>
        </template>
        <template #footer>
          <div
            v-if="selects !== null"
            data-testid="chat-choices"
            class="flex min-w-0 grow flex-wrap items-center gap-1"
          >
            <ChatSelect :select="selects.harness" @choose="chooseChat('harness', $event)" />
            <ChatModelSelect :select="selects.model" @choose="chooseChat('model', $event)" />
            <ChatSelect :select="selects.effort" @choose="chooseChat('effort', $event)" />
          </div>
          <div class="ml-auto flex items-center gap-1">
            <UButton
              icon="i-lucide-paperclip"
              color="neutral"
              variant="ghost"
              aria-label="Attach files"
              title="Attach files"
              data-testid="chat-attach"
              @click="files.pick()"
            />
            <UChatPromptSubmit
              :status="button.status"
              :aria-label="button.label"
              :title="button.label"
              icon="i-lucide-send"
              streaming-icon="i-lucide-square"
              submitted-icon="i-lucide-square"
              data-testid="chat-submit"
              :class="replying ? '' : 'bg-primary-700 text-white hover:bg-primary-800'"
              @stop="stopReply"
            />
          </div>
        </template>
      </UChatPrompt>
    </form>
    <p role="status" aria-live="polite" class="sr-only">{{ said }}</p>
  </aside>
</template>
