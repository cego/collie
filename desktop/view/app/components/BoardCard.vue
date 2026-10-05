<script setup lang="ts">
import {
  canResume,
  dispositionKinds,
  dispositionRef,
  isSettled,
  type TaskView,
} from "../../../../src/board-model";
import type { DesktopAction } from "../../../src/shared/flock";

const props = defineProps<{ task: TaskView; where: string; installation: string }>();
const { run } = useActions();
const act = (action: DesktopAction) => run(props.installation, action);

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

const dispose = (kind: "merged" | "abandoned" | "superseded") =>
  act({
    _tag: "Dispose",
    runId: props.task.run,
    kind,
    ref: kind === "abandoned" ? "" : dispositionRef(props.task.mr),
  });

/** The one action that ends this card's wait, as the TUI board draws it first. */
const primary = computed(() => {
  const view = props.task;
  if (view.decision !== null || view.landed) return null;
  if (view.state === "active" || view.state === "quiet") return null;
  if (view.planReady) {
    const offer = view.offer;
    return offer === null
      ? null
      : { label: offer.title, press: () => (offering.value = { offer: offer.id }) };
  }
  if (canResume(view.state))
    return { label: "Resume", press: () => act({ _tag: "Resume", runId: view.run }) };
  if (view.mrState === "closed")
    return { label: "Mark superseded", press: () => dispose("superseded") };
  return null;
});

/** What this Task can be asked for, by the same rules as the TUI board's menu. */
const menu = computed(() => {
  const view = props.task;
  const runId = view.run;
  const items: Array<{ label: string; onSelect: () => void }> = [];
  if (!isSettled(view.state)) {
    items.push({
      label: "Steer…",
      onSelect: () =>
        (asking.value = {
          title: `What should ${view.name} do?`,
          send: (text) => ({ _tag: "Steer", runId, text }),
        }),
    });
  }
  const offer = view.offer;
  if (offer !== null) {
    items.push({ label: offer.title, onSelect: () => (offering.value = { offer: offer.id }) });
  }
  items.push({ label: "What it offers…", onSelect: () => (offering.value = { offer: null }) });
  if (canResume(view.state)) {
    items.push({ label: "Resume run", onSelect: () => act({ _tag: "Resume", runId }) });
  }
  if (view.state === "done") {
    items.push({
      label: "Follow-up run",
      onSelect: () =>
        (asking.value = {
          title: `What still needs doing on ${view.name}?`,
          send: (text) => ({ _tag: "FollowUp", runId, text }),
        }),
    });
  }
  if (!isSettled(view.state)) {
    const held = view.held !== null;
    items.push({
      label: held ? "Release hold" : "Hold run",
      onSelect: () => act({ _tag: "Control", runId, control: "hold", set: !held }),
    });
    items.push({
      label: "Stop run",
      onSelect: () => act({ _tag: "Control", runId, control: "stop", set: true }),
    });
  }
  for (const kind of dispositionKinds(view)) {
    items.push({ label: `Mark ${kind}`, onSelect: () => dispose(kind) });
  }
  return items;
});
</script>

<template>
  <UCard :data-testid="`card-${task.id}`" :variant="task.state === 'blocked' ? 'soft' : 'outline'">
    <template #header>
      <div class="flex items-start justify-between gap-2">
        <strong data-testid="name">{{ task.name }}</strong>
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
        @confirm="act({ _tag: 'Confirm', proposal: task.decision.id, hash: task.decision.hash })"
        @decline="act({ _tag: 'Decline', proposal: task.decision.id, hash: task.decision.hash })"
      />
    </div>

    <template #footer>
      <div class="flex items-center justify-between gap-2">
        <small class="text-muted">
          <template v-if="where !== ''"
            ><span data-testid="where">{{ where }}</span> ·
          </template>
          {{ task.age }}
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
