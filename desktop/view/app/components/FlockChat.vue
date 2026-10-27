<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { QueuedMessage } from "@tanstack/ai-client";
import { DateTime, Option, type Schema } from "effect";
import { isString } from "../../../../src/schema";
import { attachedIn, dropKind, pastedImages, uriListPaths } from "../../../src/shared/attachments";
import { chatAnnouncement, replyButton, stopDraft } from "../../../src/shared/chat-choices";
import {
  aboutLine,
  DESKTOP_SAID,
  earlierNote,
  harnessName,
  questionsOf,
} from "../../../src/shared/chat-view";
import type { DesktopSettingsChange } from "../../../src/shared/flock";
import { DEFAULT_CHAT_HARNESS } from "../../../src/shared/flock-settings";

defineProps<{ alone?: boolean }>();
const emit = defineEmits<{ popOut: []; collapse: [] }>();

const {
  messages,
  queue,
  cancelQueued,
  status,
  stop,
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
const { desktopSettings } = useDesktopSettings();
const {
  selects,
  notices,
  stay,
  refused: choiceRefused,
  choose: saveChoice,
  dismiss,
} = useChatChoices();
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
  "prose prose-sm max-w-none dark:prose-invert [&_.comark-content>:first-child]:mt-0 [&_.comark-content>:last-child]:mb-0";

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
const input = useTemplateRef("input");
// Nuxt preserves focus moved outside the menu before it closes.
const chooseSetting = (change: DesktopSettingsChange) => {
  input.value?.textareaRef?.focus();
  void saveChoice(change);
};
onMounted(reload);
const files = useAttachments();
const submit = computed(() => replyButton(status.value, desktopSpeaking.value));
const liveStatus = computed(() => ({
  replying: submit.value.status !== "ready",
  notices: [notices.value.waiting?.text, notices.value.reply?.text].filter(isString),
}));
const announcement = ref("");
const announce = async (text: string) => {
  if (text === "") return;
  announcement.value = "";
  await nextTick();
  announcement.value = text;
};
watch(
  liveStatus,
  (after, before) => {
    void announce(chatAnnouncement(before ?? null, after));
  },
  { immediate: true },
);
const stayHere = () => {
  input.value?.textareaRef?.focus();
  void stay();
};
const stopReply = () => {
  const recovered = stopDraft(queue.value, {
    text: draft.value,
    files: files.pending.value,
    about: chip.value,
  });
  draft.value = recovered.text;
  files.restore(recovered.files);
  choose(recovered.about);
  const before = liveStatus.value;
  stop();
  void announce(chatAnnouncement(before, liveStatus.value, true));
  input.value?.textareaRef?.focus();
};

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

const reopened = async (conversation: Parameters<typeof reopen>[0]) => {
  const refused = await reopen(conversation);
  if (refused !== null) toast.add({ title: refused, color: "error" });
};

type EarlierItem = DropdownMenuItem & { readonly harness: string; readonly slot: "earlier" };
const earlier = ref<Array<Array<EarlierItem | DropdownMenuItem>>>([]);
const listEarlier = async (open: boolean) => {
  if (!open) return;
  const listed = await conversations();
  if (listed === null || listed.earlier.length === 0)
    return void (earlier.value = [[{ label: "No earlier conversations", disabled: true }]]);
  const note = earlierNote(
    listed.earlier,
    desktopSettings.value.chatHarness ?? DEFAULT_CHAT_HARNESS,
  );
  earlier.value = [
    listed.earlier.map(({ session, title, at, harness }) => ({
      label: title,
      description: DateTime.format(DateTime.makeUnsafe(at), {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      harness: harnessName(harness),
      slot: "earlier" as const,
      onSelect: () => void reopened({ session, harness }),
    })),
    ...(note === null
      ? []
      : [[{ type: "label" as const, label: note, ui: { label: "font-normal text-muted" } }]]),
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
    class="@container/chat flex h-full min-w-0 flex-col border-l border-default"
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
        @click="reopened(null)"
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
      <UDropdownMenu
        :items="earlier"
        :content="{ align: 'end' }"
        :ui="{ content: 'w-85' }"
        @update:open="listEarlier"
      >
        <UButton
          icon="i-lucide-history"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Earlier conversations"
          title="Earlier conversations"
          data-testid="chat-history"
        />
        <template #earlier-description="{ item }">
          <span class="flex items-center gap-1.5">
            {{ item.description }}<span aria-hidden="true">·</span>
            <span class="rounded border border-accented px-1.5 text-default">{{
              item.harness
            }}</span>
          </span>
        </template>
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
      role="log"
      aria-label="Flock chat"
      :aria-busy="isLoading || desktopSpeaking"
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
    <p role="status" aria-live="polite" aria-atomic="true" class="sr-only">{{ announcement }}</p>
    <p v-if="error" class="px-6 text-sm text-error wrap-anywhere">{{ error.message }}</p>
    <div
      v-if="choiceRefused !== null"
      role="alert"
      data-testid="chat-choice-refused"
      class="mx-6 mt-2 flex items-start gap-2 rounded-md border border-error/30 bg-error/10 py-2 pr-2 pl-3 text-sm text-error"
    >
      <UIcon name="i-lucide-circle-alert" class="mt-0.5 size-4 shrink-0" />
      <p class="grow wrap-anywhere">{{ choiceRefused }}</p>
      <UButton
        icon="i-lucide-x"
        color="error"
        variant="ghost"
        size="xs"
        aria-label="Dismiss"
        @click="dismiss()"
      />
    </div>
    <div class="flex min-w-0 flex-col gap-2 border-t border-default px-4 py-3">
      <div
        v-if="notices.waiting !== null"
        data-testid="chat-switch-waiting"
        class="flex flex-wrap items-center gap-2 rounded-md border border-info/25 bg-info/10 p-2 text-sm text-info"
      >
        <UIcon name="i-lucide-info" class="size-4 shrink-0" aria-hidden="true" />
        <p class="min-w-0 flex-1 basis-40 wrap-anywhere">{{ notices.waiting.text }}</p>
        <UButton
          type="button"
          icon="i-lucide-undo-2"
          color="info"
          variant="outline"
          size="sm"
          class="max-w-full"
          @click="stayHere"
          >{{ notices.waiting.stayLabel }}</UButton
        >
      </div>
      <div
        v-if="notices.reply !== null"
        data-testid="chat-reply-choice"
        class="flex items-start gap-2 rounded-md border border-default bg-elevated p-3 text-sm text-toned"
      >
        <UIcon name="i-lucide-clock" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p class="min-w-0 wrap-anywhere">
          This reply finishes on
          <strong class="font-semibold text-highlighted">{{ notices.reply.current }}</strong
          >. Your next message runs on
          <strong class="font-semibold text-highlighted">{{ notices.reply.next }}</strong
          >.
        </p>
      </div>
      <form class="min-w-0" @submit.prevent="send()">
        <UChatPrompt
          as="div"
          v-model="draft"
          :ui="{ header: 'flex-wrap', footer: 'flex-wrap gap-2' }"
        >
          <template #header>
            <UBadge
              v-if="chip !== null"
              data-testid="chat-chip"
              color="primary"
              variant="subtle"
              class="max-w-full gap-1"
            >
              <span class="truncate">About: {{ aboutLine(chip) }}</span>
              <UButton
                type="button"
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
          <template #body>
            <UTextarea
              ref="input"
              v-model="draft"
              data-testid="chat-input"
              class="w-full"
              variant="none"
              aria-label="Message the Flock chat"
              :rows="2"
              autoresize
              :placeholder="
                isLoading ? 'Enter queues it, Ctrl+Enter sends it now' : 'Ask about the Flock'
              "
              @keydown.enter.exact.prevent="send()"
              @keydown.ctrl.enter.exact.prevent="send(true)"
              @paste="pasted"
            />
          </template>
          <template #footer>
            <div
              data-testid="chat-choices"
              class="flex min-w-0 grow basis-full flex-wrap items-center gap-1 @[30rem]/chat:basis-auto"
            >
              <ChatChoiceSelect
                :select="selects.harness"
                @choose="chooseSetting({ chatHarness: $event })"
              />
              <ChatModelSelect
                :select="selects.model"
                @choose="chooseSetting({ chatModel: $event })"
              />
              <ChatChoiceSelect
                :select="selects.effort"
                @choose="chooseSetting({ chatEffort: $event })"
              />
            </div>
            <div class="ml-auto flex shrink-0 items-center gap-1">
              <UButton
                type="button"
                icon="i-lucide-paperclip"
                color="neutral"
                variant="ghost"
                aria-label="Attach files"
                title="Attach files"
                data-testid="chat-attach"
                @click="files.pick()"
              />
              <UChatPromptSubmit
                :status="submit.status"
                :aria-label="submit.name"
                color="primary"
                streaming-color="neutral"
                submitted-color="neutral"
                streaming-icon="i-lucide-square"
                submitted-icon="i-lucide-square"
                :class="
                  submit.status === 'ready'
                    ? 'bg-[#007f45] text-white hover:bg-[#016538] active:bg-[#016538]'
                    : ''
                "
                @stop="stopReply"
              />
            </div>
          </template>
        </UChatPrompt>
      </form>
    </div>
  </aside>
</template>
