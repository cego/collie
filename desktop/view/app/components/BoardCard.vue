<script setup lang="ts">
import {
  type CardAction,
  cardActions,
  dispositionActions,
  mrUrlOf,
  openMrLabel,
  type Proposal,
  primaryAction,
  type Question,
  type TaskView,
} from "../../../../src/board-model";
import { DateTime } from "effect";
import type { DesktopAction } from "../../../src/shared/flock";
import { type Gesture, seenBy } from "../../../src/shared/board-clicks";
import { cardQuestion, openQuestions } from "../../../src/shared/pending-answer";
import { cardFlow } from "../../../src/shared/flow-strip";

const props = defineProps<{
  task: TaskView;
  where: string;
  installation: string;
  asOf: number | null;
  cardKey: string;
  machine: string;
}>();
const { run, openLink } = useActions();
const toast = useToast();
// SAFETY: FlockBoard provides it to every card it draws.
const gesture = inject<(done: Gesture, tab?: string) => void>("gesture")!;
// A dialog opened before its Machine dropped is outside the card's disabled controls.
const act = (action: DesktopAction, tried?: (done: boolean | null) => void) =>
  run(
    props.installation,
    action,
    undefined,
    undefined,
    () => (props.asOf === null ? undefined : `its board is a saved one, ${asOfLabel.value}`),
    tried,
  );

const answering = useAnswering();
const open = computed(() => openQuestions(props.task));
const asked = computed(() => cardQuestion(props.task, props.installation, answering.state.value));
const answeringOpen = ref(false);
const answer = (question: Question, value: string, shown: string) =>
  answering.answer(props.installation, props.machine, question, value, shown, act);

const asOfLabel = computed(() => {
  if (props.asOf === null) return null;
  const { hour, minute } = DateTime.toParts(
    DateTime.makeZonedUnsafe(props.asOf, { timeZone: DateTime.zoneMakeLocal() }),
  );
  const two = (n: number) => String(n).padStart(2, "0");
  return `as of ${two(hour)}:${two(minute)}`;
});

const { chip } = useChip();
const chosen = computed(
  () => chip.value?.machine === props.machine && chip.value.task === props.task.id,
);
const openRecord = () => gesture({ kind: "name", card: props.cardKey });
const flow = computed(() => cardFlow(props.task.flow));

const STATES: Record<
  TaskView["state"],
  { label: string; color: "warning" | "info" | "neutral" | "error" | "success" }
> = {
  blocked: { label: "Needs you", color: "warning" },
  active: { label: "Working", color: "info" },
  quiet: { label: "Quiet", color: "neutral" },
  failed: { label: "Failed", color: "error" },
  stopped: { label: "Stopped", color: "neutral" },
  abandoned: { label: "Abandoned", color: "neutral" },
  done: { label: "Done", color: "success" },
};
const state = computed(() => STATES[props.task.state]);
const repoAndBranch = computed(() =>
  [props.task.project.split("/").at(-1), props.task.branch].filter(Boolean).join(" · "),
);

/** Words a Steer or a Follow-up needs before it can be sent. */
const asking = ref<{ title: string; send: (text: string) => DesktopAction } | null>(null);
/** The offers dialog: closed, choosing, or on the offer a button named. */
const offering = ref<{ offer: string | null } | null>(null);
const reviewing = ref(false);

const panes = usePanes();
const pane = computed(() => panes.shownFor(props.cardKey));
watch(
  () => props.task.run,
  () => panes.forget(props.cardKey),
);
const copy = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast.add({ title: "Copied", color: "success" }),
    () => toast.add({ title: "Could not copy the command", color: "error" }),
  );
const goTo = () =>
  props.asOf === null && gesture({ kind: "name", card: props.cardKey }, "terminal");

/**
 * A card action as this board does it, or null where Desktop has no way to yet: a check's
 * output is a tab the TUI board opens on the Machine, and attaching is the chat's.
 */
const doing = (action: CardAction, primary: boolean) => {
  const view = props.task;
  const runId = view.run;
  switch (action.kind) {
    case "go-to-tab":
      return { label: "Go to pane", press: goTo };
    case "check-output":
    case "attach":
      return null;
    case "steer":
      return {
        label: "Steer…",
        press: () =>
          (asking.value = {
            title: `What should ${view.name} do?`,
            send: (text) => ({ _tag: "Steer", runId, text }),
          }),
      };
    case "open-mr": {
      const url = mrUrlOf(action.mr);
      return url === null
        ? null
        : { label: openMrLabel(action.mr, primary), press: () => openLink(url) };
    }
    case "offer": {
      const offer = action.offer.id;
      return { label: action.offer.title, press: () => (offering.value = { offer }) };
    }
    case "offers":
      return { label: "What it offers…", press: () => (offering.value = { offer: null }) };
    case "resume":
      return {
        label: primary ? "Resume" : "Resume run",
        press: () => act({ _tag: "Resume", runId }),
      };
    case "follow-up":
      return {
        label: "Follow-up run",
        press: () =>
          (asking.value = {
            title: `What still needs doing on ${view.name}?`,
            send: (text) => ({ _tag: "FollowUp", runId, text }),
          }),
      };
    case "hold":
      return {
        label: action.set ? "Hold run" : "Release hold",
        press: () => act({ _tag: "Control", runId, control: "hold", set: action.set }),
      };
    case "stop":
      return {
        label: "Stop run",
        press: () => act({ _tag: "Control", runId, control: "stop", set: true }),
      };
    case "dispose":
      return {
        label: `Mark ${action.disposition}`,
        press: () => act({ _tag: "Dispose", runId, kind: action.disposition, ref: action.ref }),
      };
    case "acknowledge":
      return {
        label: "Acknowledge",
        press: () => {
          for (const seen of seenBy(props)) act(seen.action);
        },
      };
  }
};

/** The one action that ends this card's wait, as the TUI board draws it first. */
const primary = computed(() => {
  const action = primaryAction(props.task);
  return action === null ? null : doing(action, true);
});

/** What this Task can be asked for, as the TUI board's menu offers it, and what became of it. */
const menu = computed(() =>
  [...cardActions(props.task), ...dispositionActions(props.task)].flatMap((action) => {
    const one = doing(action, false);
    return one === null ? [] : [{ label: one.label, onSelect: one.press }];
  }),
);
</script>

<template>
  <fieldset :disabled="asOf !== null" class="contents">
    <UCard
      :data-testid="`card-${task.id}`"
      :data-card="cardKey"
      :data-as-of="asOf === null ? undefined : ''"
      :variant="task.state === 'blocked' ? 'soft' : 'outline'"
      :class="{ 'opacity-50': asOf !== null, 'ring-2 ring-primary': chosen }"
      :ui="{
        header: 'px-4 py-3 sm:px-4',
        body: 'px-4 py-3 sm:p-4 sm:py-3',
        footer: 'px-4 py-2 sm:px-4',
      }"
    >
      <template #header>
        <div class="flex items-start justify-between gap-2">
          <button
            type="button"
            class="cursor-pointer text-left font-semibold hover:underline"
            data-testid="name"
            @click="openRecord"
          >
            {{ task.name }}
          </button>
          <div class="flex shrink-0 items-center gap-1">
            <UBadge v-if="task.unseen" color="info" variant="soft" data-testid="unseen">
              Unseen
            </UBadge>
            <UBadge :color="state.color" variant="subtle" data-testid="state">
              {{ state.label }}
            </UBadge>
            <UDropdownMenu :items="menu" :content="{ align: 'end' }">
              <UButton
                icon="i-lucide-ellipsis"
                color="neutral"
                variant="ghost"
                size="xs"
                aria-label="Actions"
                data-testid="menu"
              />
            </UDropdownMenu>
          </div>
        </div>
        <small class="mt-0.5 block truncate text-muted" :title="repoAndBranch">{{
          repoAndBranch
        }}</small>
      </template>
      <p data-testid="sentence" class="text-sm">{{ task.sentence }}</p>
      <button
        v-if="flow !== null"
        type="button"
        class="mt-2 flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-left text-xs text-muted hover:text-default focus-visible:outline-2 focus-visible:outline-primary"
        :aria-label="flow.name"
        @click="gesture({ kind: 'name', card: cardKey }, 'flow')"
      >
        <span class="flex shrink-0 items-center gap-1" aria-hidden="true">
          <span
            v-for="(glyph, at) in flow.run"
            :key="at"
            :title="glyph.title"
            class="flex items-center gap-1"
            ><FlowGlyph :state="glyph.state" /><span v-if="glyph.folded !== undefined">{{
              glyph.title
            }}</span></span
          >
          <span v-if="flow.release.length > 0" class="ml-2 flex items-center gap-1">
            <FlowGlyph v-for="(glyph, at) in flow.release" :key="at" :state="glyph.state" />
          </span>
        </span>
        <span class="min-w-0">{{ flow.label }}</span>
      </button>
      <p v-if="task.held" class="text-sm text-muted">{{ task.held }}</p>
      <p v-if="task.drift" class="text-sm text-warning">{{ task.drift }}</p>

      <div v-if="asked !== null" class="mt-3 flex flex-col gap-2" data-testid="question">
        <p class="line-clamp-2 text-sm font-medium">{{ asked.text }}</p>
        <p v-if="asked.pending !== null" class="text-sm text-muted" data-testid="pending-answer">
          {{ asked.pending }}
        </p>
        <UButton
          v-else
          class="self-start"
          size="sm"
          :label="asked.label ?? ''"
          data-testid="answer-questions"
          @click="answeringOpen = true"
        />
      </div>

      <div
        v-else-if="task.decision?.kind === 'proposal'"
        class="mt-3 flex flex-col gap-2"
        data-testid="proposal"
      >
        <p class="text-sm font-medium">{{ task.decision.text }}</p>
        <UButton
          class="self-start"
          size="sm"
          label="Review…"
          data-testid="review"
          @click="reviewing = true"
        />
        <ProposalDrawer
          v-model:open="reviewing"
          :proposal="task.decision"
          @confirm="
            (shown: Proposal) => act({ _tag: 'Confirm', proposal: shown.id, hash: shown.hash })
          "
          @decline="
            (shown: Proposal) => act({ _tag: 'Decline', proposal: shown.id, hash: shown.hash })
          "
        />
      </div>

      <div v-if="pane" class="mt-2 flex flex-col gap-1 text-xs text-muted" data-testid="pane">
        <span class="flex min-w-0 items-center gap-1" :title="pane.where"
          ><UIcon name="i-lucide-terminal" class="shrink-0" aria-hidden="true" /><span
            class="truncate"
            data-testid="pane-where"
            >{{ pane.line }}</span
          ></span
        >
        <div v-if="pane.command !== null" class="flex items-center gap-1">
          <code class="truncate text-xs" data-testid="pane-command">{{ pane.command }}</code>
          <UButton
            icon="i-lucide-copy"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Copy command"
            @click="copy(pane.command)"
          />
        </div>
      </div>

      <template #footer>
        <div class="flex items-center justify-between gap-2">
          <small class="text-muted">
            <template v-if="where !== ''"
              ><span data-testid="where">{{ where }}</span> ·
            </template>
            {{ task.age }}
            <template v-if="asOfLabel !== null">
              · <span data-testid="as-of">{{ asOfLabel }}</span>
            </template>
            <template v-if="task.agents.length > 0">
              · {{ task.agents.length === 1 ? "1 agent" : `${task.agents.length} agents` }}
            </template>
          </small>
          <UButton
            v-if="primary"
            size="xs"
            :label="primary.label"
            data-testid="primary"
            @click="primary.press()"
          />
        </div>
      </template>
    </UCard>
  </fieldset>

  <TextDialog
    :open="asking !== null"
    :title="asking?.title ?? ''"
    @update:open="(open: boolean) => !open && (asking = null)"
    @send="(text: string) => asking && act(asking.send(text))"
  />
  <QuestionDialog
    v-if="answeringOpen"
    :title="task.name"
    :installation="installation"
    :open="open"
    @answer="answer"
    @close="answeringOpen = false"
  />
  <OffersDialog
    v-if="offering !== null"
    :installation="installation"
    :run-id="task.run"
    :chosen="offering.offer"
    @close="offering = null"
  />
</template>
