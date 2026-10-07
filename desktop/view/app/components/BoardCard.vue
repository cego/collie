<script setup lang="ts">
import {
  type CardAction,
  cardActions,
  dispositionActions,
  mrUrlOf,
  type Proposal,
  primaryAction,
  type TaskView,
} from "../../../../src/board-model";
import { DateTime } from "effect";
import type { DesktopAction } from "../../../src/shared/flock";

const props = defineProps<{
  task: TaskView;
  where: string;
  installation: string;
  asOf: number | null;
  cardKey: string;
  machine: string;
}>();
const { run, openLink, goToPane } = useActions();
const toast = useToast();
const { open } = useDrawer();
// A dialog opened before its Machine dropped is outside the card's disabled controls.
const act = (action: DesktopAction) =>
  props.asOf === null ? run(props.installation, action) : Promise.resolve(false);

const asOfLabel = computed(() => {
  if (props.asOf === null) return null;
  const { hour, minute } = DateTime.toParts(
    DateTime.makeZonedUnsafe(props.asOf, { timeZone: DateTime.zoneMakeLocal() }),
  );
  const two = (n: number) => String(n).padStart(2, "0");
  return `as of ${two(hour)}:${two(minute)}`;
});

const { chip, choose } = useChip();
const chosen = computed(
  () => chip.value?.machine === props.machine && chip.value.task === props.task.id,
);
/** A click on the card itself, not on one of its controls, is what the next chat message is about. */
const chooseForChat = (event: MouseEvent) => {
  if (event.target instanceof Element && event.target.closest("button, a, input, label, form"))
    return;
  choose({
    machine: props.machine,
    task: props.task.id,
    run: props.task.run,
    name: props.task.name,
  });
};

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

const typed = ref("");
const kept = ref<ReadonlyArray<string>>([]);
watch(
  () => props.task.decision,
  (decision) => {
    kept.value = decision?.kind === "gate" ? decision.verifications : [];
  },
  { immediate: true },
);
const toggle = (name: string, on: boolean | "indeterminate") => {
  const gate = props.task.decision;
  if (gate?.kind !== "gate") return;
  kept.value = gate.verifications.filter((one) =>
    one === name ? on === true : kept.value.includes(one),
  );
};

/** Where Go to pane last found this card's pane, and the herdr client that attaches to it. */
const pane = ref<{ where: string; command: string; opened: boolean } | null>(null);
watch(
  () => props.task.run,
  () => (pane.value = null),
);
const copy = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast.add({ title: "Copied", color: "success" }),
    () => toast.add({ title: "Could not copy the command", color: "error" }),
  );
const goTo = async () => {
  if (props.asOf !== null) return;
  const went = await goToPane(props.installation, props.task.run);
  if (went === null) return;
  const where = [props.machine, went.at.workspace, went.at.tab]
    .filter((part) => part !== null)
    .join(" › ");
  pane.value = { where, command: went.command, opened: went.opened };
  toast.add(
    went.opened
      ? { title: `Opened ${where} in a terminal`, color: "success" }
      : { title: "No terminal found: copy the command on the card", color: "warning" },
  );
};

/**
 * A card action as this board does it, or null where Desktop has no way to yet: a check's
 * output is a tab the TUI board opens on the Machine, and attaching is the chat's.
 */
const doing = (action: CardAction, primary: boolean) => {
  const view = props.task;
  const runId = view.run;
  switch (action.kind) {
    case "go-to-tab":
      return { label: "Go to pane", press: () => void goTo() };
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
        : { label: primary ? "Open MR" : "Open merge request", press: () => openLink(url) };
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
      :variant="task.state === 'blocked' ? 'soft' : 'outline'"
      :class="{ 'opacity-50': asOf !== null, 'ring-2 ring-primary': chosen }"
      @click="chooseForChat"
    >
      <template #header>
        <div class="flex items-start justify-between gap-2">
          <button
            type="button"
            class="cursor-pointer text-left font-semibold hover:underline"
            data-testid="name"
            @click="open(cardKey)"
          >
            {{ task.name }}
          </button>
          <div class="flex shrink-0 items-center gap-1">
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
        <small class="text-muted">{{ repoAndBranch }}</small>
      </template>
      <p data-testid="sentence" class="text-sm">{{ task.sentence }}</p>
      <p v-if="task.held" class="text-sm text-muted">{{ task.held }}</p>
      <p v-if="task.drift" class="text-sm text-warning">{{ task.drift }}</p>

      <div
        v-if="task.decision?.kind === 'question'"
        class="mt-3 flex flex-col gap-2"
        data-testid="question"
      >
        <p class="text-sm font-medium">{{ task.decision.text }}</p>
        <div v-if="task.decision.options.length > 0" class="flex flex-wrap gap-2">
          <UButton
            v-for="option in task.decision.options"
            :key="option.id"
            :data-testid="`option-${option.id}`"
            size="sm"
            :label="option.title"
            @click="
              act({
                _tag: 'Answer',
                runId: task.decision.run,
                decision: task.decision.id,
                value: option.id,
              })
            "
          />
        </div>
        <form
          v-else
          class="flex gap-2"
          @submit.prevent="
            typed.trim() !== '' &&
            act({
              _tag: 'Answer',
              runId: task.decision.run,
              decision: task.decision.id,
              value: typed.trim(),
            })
          "
        >
          <UInput v-model="typed" class="flex-1" size="sm" data-testid="answer" />
          <UButton type="submit" size="sm" label="Send" data-testid="send-answer" />
        </form>
      </div>

      <div
        v-else-if="task.decision?.kind === 'gate'"
        class="mt-3 flex flex-col gap-2"
        data-testid="gate"
      >
        <p class="text-sm font-medium">Approve these checks before it carries on:</p>
        <UCheckbox
          v-for="name in task.decision.verifications"
          :key="name"
          :data-testid="`check-${name}`"
          :label="name"
          :model-value="kept.includes(name)"
          @update:model-value="toggle(name, $event)"
        />
        <UButton
          class="self-start"
          size="sm"
          label="Approve"
          data-testid="approve"
          :disabled="kept.length === 0"
          @click="
            act({
              _tag: 'Answer',
              runId: task.decision.run,
              decision: task.decision.id,
              value:
                kept.length === task.decision.verifications.length
                  ? 'approve'
                  : `approve:${kept.join(',')}`,
            })
          "
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

      <div v-if="pane" class="mt-3 flex flex-col gap-1 text-sm" data-testid="pane">
        <span data-testid="pane-where">{{ pane.where }}</span>
        <div v-if="!pane.opened" class="flex items-center gap-1">
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
  <OffersDialog
    v-if="offering !== null"
    :installation="installation"
    :run-id="task.run"
    :chosen="offering.offer"
    @close="offering = null"
  />
</template>
