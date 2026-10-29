<script setup lang="ts">
import { injectRegistry } from "@effect/atom-vue";
import { Clock, Effect } from "effect";
import { settingStored } from "../../../../src/settings";
import {
  desktopChange,
  flockReach,
  NO_FLOCK_SETTINGS,
  type Said,
  type SettingRow,
  type SettingSection,
  settingSections,
  syncPill,
} from "../../../src/shared/flock-settings";
import { drawnSaid } from "../../../src/shared/scale";
import {
  agentSettingChanges,
  changeFallbacks,
  fallbackList,
  settingsAgentSelects,
} from "../../../src/shared/settings-agents";
import { drawnAtom, flockSettingsAtom } from "../flock";

const emit = defineEmits<{ back: [] }>();
const { setFlockSetting, setFlockSettings } = useActions();
const {
  cards: connectionCards,
  workflows: connectionWorkflows,
  trouble: connectionTrouble,
  reading: readingConnections,
  refresh: refreshConnections,
} = useConnections();
const connectionsNeedYou = computed(
  () => connectionCards.value.filter((card) => card.needsYou).length,
);
const {
  choices: slackChoices,
  trouble: slackTrouble,
  loading: slackLoading,
  refresh: refreshSlack,
} = useSlack();
const slackDestinations = computed(() =>
  connectionCards.value.some((card) => card.id === "slack" && card.account !== null)
    ? slackChoices.value
    : null,
);
watch(connectionCards, () => {
  void refreshSlack();
});
const refreshSlackConnection = () => {
  void refreshConnections();
  void refreshSlack();
};
const { desktopSettings, change } = useDesktopSettings();
const { rows: machines, own, now } = useFlock();
const { machines: catalogues, problem: catalogueProblem } = useCatalogues();
const { machines: usage } = useUsage();
const { open: openPage } = usePage();
const { value: held, trouble } = useHeld(() => flockSettingsAtom);
// Asked again on opening, which syncs every connected Machine and so shows their edits.
const registry = injectRegistry();
onMounted(() => registry.refresh(flockSettingsAtom));
/** Whether the Flock's settings can be read now; an edit made otherwise would be blind. */
const readable = computed(() => held.value !== undefined && trouble.value === null);
const sections = computed(() =>
  settingSections(
    held.value ?? NO_FLOCK_SETTINGS,
    desktopSettings.value,
    Effect.runSync(Clock.currentTimeMillis),
  ),
);
const agentRows = computed(() => sections.value.find(({ group }) => group === "Agents")!.rows);
const agentValue = (key: string) => {
  const row = agentRows.value.find((row) => row.key === key)!;
  return row.value || row.fallback;
};
const profiles = computed(() => machines.value.map(({ profile }) => profile));
const agentSettings = computed(() => ({
  harness: agentValue("harness"),
  model: agentValue("model"),
  effort: agentValue("effort"),
}));
const agentSelects = computed(() =>
  settingsAgentSelects(catalogues.value, profiles.value, agentSettings.value, now.value),
);
const fallbacks = computed(() =>
  fallbackList(agentValue("fallbacks"), catalogues.value, profiles.value, usage.value, now.value),
);
const choosing = ref(false);
const chooseAgent = async (key: "harness" | "model" | "effort", value: string, reset = false) => {
  if (choosing.value) return;
  choosing.value = true;
  const row = agentRows.value.find((row) => row.key === key)!;
  forget(idOf(row));
  try {
    const reach = flockReach(readable.value, machines.value);
    if ("refused" in reach) return void (refusals.value[idOf(row)] = reach.refused);
    const changes = agentSettingChanges(
      catalogues.value,
      profiles.value,
      agentSettings.value,
      key,
      reset ? row.fallback : key === "model" && value === "" ? "default" : value,
    ).map((edit) => ({ ...edit, value: reset && edit.key === key ? "" : edit.value }));
    const refused = await setFlockSettings(changes);
    if (refused !== null) return void (refusals.value[idOf(row)] = refused);
    for (const edit of changes)
      saved.value[idOf(agentRows.value.find((row) => row.key === edit.key)!)] = true;
  } finally {
    choosing.value = false;
  }
};
const chooseFallback = async (row: SettingRow, value: string) => {
  if (choosing.value) return;
  choosing.value = true;
  try {
    await set(row, value);
  } finally {
    choosing.value = false;
  }
};
const resetRow = (row: SettingRow) =>
  row.key === "harness" || row.key === "model" || row.key === "effort"
    ? chooseAgent(row.key, "", true)
    : row.key === "fallbacks"
      ? chooseFallback(row, "")
      : set(row, "");
const pill = computed(() => syncPill(readable.value, machines.value));
const toneClass = { ok: "text-primary", warn: "text-warning" } satisfies Record<
  Said["tone"],
  string
>;

const query = ref("");
const onlySet = ref(false);
const advancedOpen = ref(false);
const filtering = computed(() => query.value.trim() !== "" || onlySet.value);
const kept = (row: SettingRow) => {
  const asked = query.value.trim().toLowerCase();
  return (
    (!onlySet.value || row.set) &&
    `${row.label} ${row.key} ${row.description}`.toLowerCase().includes(asked)
  );
};
const LEADS: Partial<Record<SettingSection["group"], string>> = {
  Board: "Scope and density change the TUI's board; Desktop's board is not changed.",
  Chat: "The Flock chat in Desktop, and each Machine's Native chat. The Flock chat's harness, model and effort are picked in its composer, on this computer.",
};
/** Each section's rows that the search keeps, under their sub-groups in order. */
const shown = computed(() =>
  sections.value.flatMap((section) => {
    const rows = section.rows.filter(kept);
    if (rows.length === 0) return [];
    const subs = [...new Set(rows.map(({ sub }) => sub))].map((sub) => ({
      sub,
      rows: rows.filter((row) => row.sub === sub),
      collapsed: sub === "Advanced" && !advancedOpen.value && !filtering.value,
      all: section.rows.filter((row) => row.sub === sub).length,
    }));
    return [
      {
        ...section,
        subs,
        set: section.rows.filter(({ set }) => set).length,
        lead:
          section.group === "Agents"
            ? `What every step's agent runs on, unless it names its own. ${catalogueProblem.value ?? agentSelects.value.lead}`
            : LEADS[section.group],
      },
    ];
  }),
);
const total = computed(() => sections.value.reduce((sum, { rows }) => sum + rows.length, 0));
const shownCount = computed(() =>
  shown.value.reduce((sum, { subs }) => sum + subs.reduce((n, { rows }) => n + rows.length, 0), 0),
);
const showConnections = computed(
  () =>
    !onlySet.value &&
    "connections gitlab github gh linear host token helle slack credentials glab gitlab_host".includes(
      query.value.trim().toLowerCase(),
    ),
);
const showAbout = computed(
  () =>
    !filtering.value ||
    "about version update collie desktop".includes(query.value.trim().toLowerCase()),
);
const showOwn = computed(
  () =>
    !onlySet.value &&
    "each machine's own projects.root chat_harness harnesses found remembered linear.team gitlab.assignee".includes(
      query.value.trim().toLowerCase(),
    ),
);
const clearFilters = () => {
  query.value = "";
  onlySet.value = false;
};
const goTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

const idOf = (row: SettingRow) =>
  `${row.shared ? "flock" : "desktop"}-${row.key}`.replace(/\./g, "-");
/** What is typed into a field, until it is set. */
const drafts = ref<Record<string, string>>({});
const refusals = ref<Record<string, string>>({});
/** The rows edited since the page opened, which say how far the edit reached. */
const saved = ref<Record<string, true>>({});
const draftOf = (row: SettingRow) => drafts.value[idOf(row)] ?? row.value;
const dirty = (row: SettingRow) => draftOf(row) !== row.value;
const effective = (row: SettingRow) => row.value || row.fallback;
const forget = (id: string) => {
  delete refusals.value[id];
  delete saved.value[id];
};
const revert = (row: SettingRow) => {
  delete drafts.value[idOf(row)];
  forget(idOf(row));
};
const typing = (row: SettingRow, typed: string) => {
  drafts.value[idOf(row)] = typed;
  forget(idOf(row));
};
/** `typed` in the row's unit; empty unsets it. */
const set = async (row: SettingRow, typed: string) => {
  const id = idOf(row);
  forget(id);
  const refused = row.shared
    ? await setShared(row, typed)
    : await change(desktopChange(row.key, typed));
  if (refused !== null) return void (refusals.value[id] = refused);
  delete drafts.value[id];
  saved.value[id] = true;
};
const setShared = async (row: SettingRow, typed: string) => {
  const reach = flockReach(readable.value, machines.value);
  if ("refused" in reach) return reach.refused;
  const stored = settingStored(row.key, typed);
  return "refused" in stored ? stored.refused : setFlockSetting(row.key, stored.stored);
};
interface Meta {
  readonly said: string;
  /** Its colour, as classes. */
  readonly tone: string;
}
/** What a row says under its control: how far its latest edit reached, else whose edit it is. */
const metaOf = (row: SettingRow): Meta => {
  if (saved.value[idOf(row)] !== undefined) {
    if (!row.shared) return { said: "Saved on this computer", tone: toneClass.ok };
    const reach = flockReach(readable.value, machines.value);
    return "refused" in reach
      ? { said: reach.refused, tone: "text-error" }
      : { said: reach.said, tone: toneClass[reach.tone] };
  }
  if (dirty(row))
    return {
      said: row.multiline
        ? "Edited, not set yet · Ctrl+Enter sets it"
        : "Enter sets it · Esc puts it back",
      tone: row.multiline ? "text-warning" : "",
    };
  if (row.edit?.startsWith("Taken from")) return { said: row.edit, tone: "text-info" };
  return {
    said: row.edit === null ? row.defaultSaid : `${row.edit} · ${row.defaultSaid.toLowerCase()}`,
    tone: "",
  };
};
const areaKey = (row: SettingRow, event: KeyboardEvent) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void set(row, draftOf(row));
  }
};

const { value: drawn } = useHeld(() => drawnAtom);
/** The view's own pixel ratio, read again as a zoom resizes its viewport. */
const ratio = ref(window.devicePixelRatio);
const readRatio = () => (ratio.value = window.devicePixelRatio);
onMounted(() => window.addEventListener("resize", readRatio));
onUnmounted(() => window.removeEventListener("resize", readRatio));
watch(drawn, readRatio);
const drawnLine = computed(() =>
  drawn.value === undefined ? null : drawnSaid(drawn.value, ratio.value),
);
</script>

<template>
  <section data-testid="settings-page" class="flex flex-col bg-default">
    <PageHeader title="Settings" page="settings" @back="emit('back')">
      <p
        class="flex items-center gap-2 text-sm"
        :class="toneClass[pill.tone]"
        role="status"
        data-testid="sync-pill"
      >
        <span
          class="size-2 rounded-full"
          :class="pill.tone === 'ok' ? 'bg-primary' : 'bg-warning'"
          aria-hidden="true"
        />
        {{ pill.said }}
      </p>
    </PageHeader>
    <div class="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
      <div class="flex flex-col gap-4" :class="columnClass('settings')">
        <div class="flex flex-wrap items-center gap-3" role="search">
          <UInput
            v-model="query"
            class="min-w-60 flex-1"
            type="search"
            icon="i-lucide-search"
            placeholder="Find a setting by name, key or what it does"
            aria-label="Find a setting"
            data-testid="settings-search"
          />
          <UCheckbox v-model="onlySet" label="Only what is set" data-testid="settings-only-set" />
          <span class="ml-auto text-sm text-muted" aria-live="polite">
            {{ filtering ? `${shownCount} of ${total} settings shown` : `${total} settings` }}
          </span>
        </div>
        <div class="flex flex-wrap items-start gap-6">
          <nav
            aria-label="Settings sections"
            class="sticky top-0 flex w-52 shrink-0 flex-col gap-4 max-md:static max-md:w-full"
            data-testid="settings-index"
          >
            <div class="flex flex-col gap-0.5">
              <span class="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-dimmed">
                Every Machine
              </span>
              <UButton
                v-for="section in shown"
                :key="section.group"
                color="neutral"
                variant="ghost"
                size="sm"
                :label="section.group"
                @click="goTo(`settings-${section.group}`)"
              >
                <template #trailing>
                  <span v-if="section.set > 0" class="ml-auto text-xs text-muted">
                    {{ section.set }} set
                  </span>
                </template>
              </UButton>
              <UButton
                v-if="showConnections"
                color="neutral"
                variant="ghost"
                size="sm"
                label="Connections"
                @click="goTo('connections')"
              >
                <template #trailing
                  ><span v-if="connectionsNeedYou > 0" class="ml-auto text-xs text-warning"
                    >{{ connectionsNeedYou }} need you</span
                  ></template
                >
              </UButton>
            </div>
            <div v-if="showOwn || showAbout" class="flex flex-col gap-0.5">
              <span class="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-dimmed">
                Elsewhere
              </span>
              <UButton
                v-if="showOwn"
                color="neutral"
                variant="ghost"
                size="sm"
                label="Each Machine's own"
                @click="goTo('machine-own')"
              />
              <UButton
                v-if="showAbout"
                color="neutral"
                variant="ghost"
                size="sm"
                label="About"
                @click="goTo('about')"
              />
            </div>
          </nav>

          <main class="flex min-w-0 flex-[999_1_32rem] flex-col gap-6">
            <RetryNotice
              v-if="trouble !== null"
              title="The Flock's settings could not be read; showing what they last were"
              :trouble="trouble"
            />
            <div
              class="grid grid-cols-1 gap-3 text-sm text-muted md:grid-cols-3"
              aria-label="Where a setting applies"
              data-testid="settings-legend"
            >
              <p class="rounded-lg border border-default p-3">
                <UBadge size="sm" variant="subtle" label="Every Machine" class="mb-1.5" /><br />
                The Flock's. Given to each Machine through its host; the latest edit of a key wins,
                wherever it was made.
              </p>
              <p class="rounded-lg border border-default p-3">
                <UBadge
                  size="sm"
                  variant="subtle"
                  color="neutral"
                  label="This computer"
                  class="mb-1.5"
                /><br />
                Zoom alone. Saved on this computer, so each computer draws at its own size.
              </p>
              <p class="rounded-lg border border-default p-3">
                <UBadge
                  size="sm"
                  variant="outline"
                  color="neutral"
                  label="Each Machine's own"
                  class="mb-1.5"
                /><br />
                Stays in that Machine's config.json, such as projects.root. Edited in that Machine's
                TUI.
              </p>
            </div>

            <div
              v-if="shownCount === 0 && !showConnections && !showAbout && !showOwn"
              class="flex flex-col items-start gap-2"
            >
              <p class="font-semibold">No setting matches “{{ query }}”.</p>
              <UButton
                color="neutral"
                variant="outline"
                label="Show every setting"
                @click="clearFilters"
              />
            </div>

            <section
              v-if="shown.length > 0 || showConnections"
              class="flex flex-col gap-6 rounded-xl border border-default p-4"
              aria-labelledby="band-flock"
              data-testid="band-flock"
            >
              <div class="flex flex-col gap-1">
                <h3 id="band-flock" class="flex items-center gap-2 text-base font-semibold">
                  <UIcon name="i-lucide-network" class="text-primary" />
                  Every Machine
                </h3>
                <p class="text-sm text-muted">
                  The Flock's settings. Desktop gives each edit to every Machine through its host;
                  an edit in any Machine's TUI counts the same. Each key is its latest edit,
                  wherever it was made.
                </p>
                <p
                  v-if="readable && pill.tone === 'warn'"
                  class="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning"
                >
                  A Machine out of reach gets every edit made meanwhile when it connects, unless it
                  made a later one itself.
                </p>
              </div>
              <section
                v-for="section in shown"
                :id="`settings-${section.group}`"
                :key="section.group"
                class="flex flex-col gap-4"
                :data-testid="`settings-${section.group}`"
              >
                <div class="flex flex-col gap-0.5">
                  <h3 class="text-sm font-semibold">{{ section.group }}</h3>
                  <p v-if="section.lead" class="text-sm text-muted">{{ section.lead }}</p>
                </div>
                <div v-for="sub in section.subs" :key="sub.sub" class="flex flex-col gap-3">
                  <div v-if="sub.sub !== ''" class="flex items-center gap-2">
                    <h4 class="text-xs font-semibold uppercase tracking-wide text-dimmed">
                      {{ sub.sub }}
                    </h4>
                    <UButton
                      v-if="sub.sub === 'Advanced' && !filtering"
                      size="xs"
                      color="neutral"
                      variant="link"
                      :aria-expanded="!sub.collapsed"
                      :label="advancedOpen ? 'Hide' : `Show ${sub.all} more`"
                      @click="advancedOpen = !advancedOpen"
                    />
                  </div>
                  <div
                    v-if="!sub.collapsed"
                    :class="
                      sub.sub === 'Toasts'
                        ? 'grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2'
                        : 'flex flex-col gap-5'
                    "
                  >
                    <div
                      v-for="row in sub.rows"
                      :key="idOf(row)"
                      class="flex flex-col gap-1.5"
                      :data-testid="`setting-${idOf(row)}`"
                    >
                      <div
                        :class="
                          sub.sub === 'Toasts'
                            ? 'flex items-start justify-between gap-3'
                            : 'contents'
                        "
                      >
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <div class="flex flex-wrap items-baseline gap-2">
                            <label :id="`label-${idOf(row)}`" :for="idOf(row)" class="font-medium">
                              {{ row.label }}
                            </label>
                            <code class="text-xs text-muted">{{ row.key }}</code>
                            <UBadge
                              v-if="!row.shared"
                              class="ml-auto"
                              size="sm"
                              variant="subtle"
                              color="neutral"
                              icon="i-lucide-monitor"
                              label="This computer"
                            />
                          </div>
                          <p :id="`desc-${idOf(row)}`" class="text-sm text-muted">
                            {{ row.description }}
                          </p>
                        </div>
                        <div
                          v-if="row.shared && ['harness', 'model', 'effort'].includes(row.key)"
                          class="self-start"
                        >
                          <fieldset :disabled="choosing" class="contents">
                            <ChatModelSelect
                              v-if="row.key === 'model'"
                              :id="idOf(row)"
                              :select="agentSelects.model"
                              :aria-describedby="`desc-${idOf(row)} err-${idOf(row)}`"
                              @choose="(value) => chooseAgent('model', value)"
                            />
                            <ChatChoiceSelect
                              v-else
                              :id="idOf(row)"
                              :select="
                                row.key === 'harness' ? agentSelects.harness : agentSelects.effort
                              "
                              :aria-describedby="`desc-${idOf(row)} err-${idOf(row)}`"
                              @choose="
                                (value) =>
                                  chooseAgent(row.key === 'harness' ? 'harness' : 'effort', value)
                              "
                            />
                          </fieldset>
                          <p
                            v-if="row.key === 'model' && agentSelects.model.warning"
                            class="text-sm text-warning"
                            role="status"
                          >
                            {{ agentSelects.model.warning }}
                          </p>
                        </div>
                        <fieldset
                          v-else-if="row.key === 'fallbacks'"
                          :disabled="choosing"
                          class="flex flex-col gap-2"
                        >
                          <ol
                            v-if="fallbacks.entries.length"
                            class="flex flex-col gap-2"
                            :aria-labelledby="`label-${idOf(row)}`"
                          >
                            <li
                              v-for="(entry, index) in fallbacks.entries"
                              :key="`${index}:${entry.value}`"
                              class="flex items-center gap-2 rounded-md border border-default p-2"
                            >
                              <span class="text-sm text-muted" aria-hidden="true">{{
                                index + 1
                              }}</span>
                              <div class="flex min-w-0 flex-1 flex-col gap-1">
                                <code class="break-all text-sm">{{ entry.value }}</code>
                                <span
                                  v-for="reading in entry.usage"
                                  :key="reading.key"
                                  :title="reading.title"
                                  class="text-xs"
                                  :class="
                                    reading.level === 'out'
                                      ? 'text-error'
                                      : reading.level === 'warn'
                                        ? 'text-warning'
                                        : 'text-muted'
                                  "
                                  >{{ reading.text }}</span
                                >
                              </div>
                              <UButton
                                icon="i-lucide-arrow-up"
                                color="neutral"
                                variant="ghost"
                                :aria-label="`Move ${entry.value} up`"
                                :disabled="index === 0"
                                @click="
                                  chooseFallback(
                                    row,
                                    changeFallbacks(row.value, { at: index, move: 'up' }),
                                  )
                                "
                              />
                              <UButton
                                icon="i-lucide-arrow-down"
                                color="neutral"
                                variant="ghost"
                                :aria-label="`Move ${entry.value} down`"
                                :disabled="index === fallbacks.entries.length - 1"
                                @click="
                                  chooseFallback(
                                    row,
                                    changeFallbacks(row.value, { at: index, move: 'down' }),
                                  )
                                "
                              />
                              <UButton
                                icon="i-lucide-x"
                                color="neutral"
                                variant="ghost"
                                :aria-label="`Remove ${entry.value}`"
                                @click="
                                  chooseFallback(
                                    row,
                                    changeFallbacks(row.value, { at: index, move: 'remove' }),
                                  )
                                "
                              />
                            </li>
                          </ol>
                          <p v-else class="text-sm text-muted">
                            None: a step whose Subscription is used up waits for the reset.
                          </p>
                          <div class="self-start">
                            <ChatModelSelect
                              :id="idOf(row)"
                              :select="fallbacks.add"
                              @choose="
                                (value) =>
                                  chooseFallback(row, changeFallbacks(row.value, { add: value }))
                              "
                            />
                          </div>
                        </fieldset>
                        <USwitch
                          v-else-if="row.kind === 'boolean'"
                          :id="idOf(row)"
                          :model-value="effective(row) === 'true'"
                          :aria-describedby="`desc-${idOf(row)}`"
                          :label="
                            sub.sub === 'Toasts'
                              ? undefined
                              : effective(row) === 'true'
                                ? 'On'
                                : 'Off'
                          "
                          @update:model-value="(on) => set(row, String(on))"
                        />
                      </div>
                      <SlackDestination
                        v-if="
                          ['release.approval_channel', 'slack.notification_channel'].includes(
                            row.key,
                          )
                        "
                        :id="idOf(row)"
                        :setting="row.key"
                        :value="row.value"
                        :choices="slackDestinations"
                        @choose="(value) => set(row, value)"
                      />
                      <fieldset
                        v-else-if="
                          sub.sub !== 'Who does the work' &&
                          row.kind === 'choice' &&
                          row.choices.length <= 6
                        "
                        :id="idOf(row)"
                        class="flex flex-wrap gap-0.5 self-start rounded-lg border border-default bg-elevated p-0.5"
                        :aria-labelledby="`label-${idOf(row)}`"
                        :aria-describedby="`desc-${idOf(row)}`"
                      >
                        <label
                          v-for="choice in row.choices"
                          :key="choice"
                          class="flex min-h-8 cursor-pointer items-center rounded-md px-3 text-sm font-medium has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-primary"
                          :class="
                            effective(row) === choice
                              ? 'bg-default text-highlighted shadow-sm ring-1 ring-accented'
                              : 'text-muted hover:text-default'
                          "
                        >
                          <input
                            type="radio"
                            class="sr-only"
                            :name="idOf(row)"
                            :value="choice"
                            :checked="effective(row) === choice"
                            @change="set(row, choice)"
                          />
                          {{ choice }}
                        </label>
                      </fieldset>
                      <USelect
                        v-else-if="sub.sub !== 'Who does the work' && row.kind === 'choice'"
                        :id="idOf(row)"
                        class="self-start"
                        :model-value="row.value === '' ? undefined : row.value"
                        :items="[...row.choices]"
                        :placeholder="row.fallback"
                        @update:model-value="(chosen) => set(row, String(chosen))"
                      />
                      <form
                        v-else-if="sub.sub !== 'Who does the work' && row.kind !== 'boolean'"
                        class="flex items-start gap-2"
                        :class="row.multiline ? 'flex-col items-stretch' : ''"
                        @submit.prevent="set(row, draftOf(row))"
                      >
                        <UTextarea
                          v-if="row.multiline"
                          :id="idOf(row)"
                          :rows="3"
                          autoresize
                          :class="row.kind === 'json' ? 'font-mono' : ''"
                          :model-value="draftOf(row)"
                          :color="refusals[idOf(row)] ? 'error' : undefined"
                          :highlight="refusals[idOf(row)] !== undefined"
                          :placeholder="
                            row.kind === 'json'
                              ? '{&quot;*&quot;: {&quot;env&quot;: {&quot;NAME&quot;: &quot;value&quot;}}}'
                              : 'Frontend work is on the laptop, everything else is on the vm'
                          "
                          :aria-invalid="refusals[idOf(row)] !== undefined"
                          :aria-describedby="`desc-${idOf(row)} err-${idOf(row)}`"
                          :data-testid="`${idOf(row)}-text`"
                          @update:model-value="(typed) => typing(row, String(typed))"
                          @keydown="(event: KeyboardEvent) => areaKey(row, event)"
                          @keydown.esc.prevent="revert(row)"
                        />
                        <UInput
                          v-else
                          :id="idOf(row)"
                          class="flex-1"
                          :type="row.kind === 'number' ? 'number' : 'text'"
                          :step="row.kind === 'number' ? 'any' : undefined"
                          :model-value="draftOf(row)"
                          :color="refusals[idOf(row)] ? 'error' : undefined"
                          :highlight="refusals[idOf(row)] !== undefined"
                          :placeholder="row.kind === 'list' ? 'none, or a, b' : row.fallback"
                          :aria-invalid="refusals[idOf(row)] !== undefined"
                          :aria-describedby="`desc-${idOf(row)} err-${idOf(row)}`"
                          :ui="{ trailing: 'pointer-events-none' }"
                          @update:model-value="(typed) => typing(row, String(typed))"
                          @keydown.esc.prevent="revert(row)"
                        >
                          <template v-if="row.unit" #trailing>
                            <span class="text-sm text-muted">{{ row.unit }}</span>
                          </template>
                        </UInput>
                        <div class="flex justify-end gap-2">
                          <UButton
                            v-if="row.multiline && dirty(row)"
                            color="neutral"
                            variant="ghost"
                            label="Discard edit"
                            @click="revert(row)"
                          />
                          <UButton
                            type="submit"
                            label="Set"
                            :variant="dirty(row) ? 'solid' : 'outline'"
                            :color="dirty(row) ? 'primary' : 'neutral'"
                            :disabled="!dirty(row)"
                          />
                        </div>
                      </form>
                      <p
                        v-if="refusals[idOf(row)]"
                        :id="`err-${idOf(row)}`"
                        class="flex items-start gap-1.5 text-sm text-error"
                        role="alert"
                      >
                        <UIcon name="i-lucide-circle-alert" class="mt-0.5 shrink-0" />
                        {{ refusals[idOf(row)] }}
                      </p>
                      <p
                        v-if="row.hint"
                        class="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning"
                      >
                        {{ row.hint }}
                      </p>
                      <p
                        v-if="row.key === 'zoom' && drawnLine !== null"
                        class="text-sm text-muted"
                        data-testid="drawn"
                      >
                        {{ drawnLine }}
                      </p>
                      <div
                        class="flex min-h-6 flex-wrap items-center gap-2 text-xs text-muted"
                        aria-live="polite"
                      >
                        <span :class="metaOf(row).tone">{{ metaOf(row).said }}</span>
                        <UButton
                          v-if="row.set && !dirty(row)"
                          class="ml-auto"
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          icon="i-lucide-rotate-ccw"
                          label="Reset to default"
                          :aria-label="`Reset ${row.label} to default`"
                          :disabled="sub.sub === 'Who does the work' && choosing"
                          @click="resetRow(row)"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </section>
              <SettingsConnections
                :slack="slackChoices"
                :slack-trouble="slackTrouble"
                :slack-loading="slackLoading"
                @refresh-slack="refreshSlackConnection"
                v-if="showConnections"
                :cards="connectionCards"
                :workflows="connectionWorkflows"
                :reading="readingConnections"
                :trouble="connectionTrouble"
                @refresh="refreshConnections"
              >
                <template #slack-destination>
                  <div
                    v-for="row in sections
                      .flatMap((section) => section.rows)
                      .filter((row) => row.key === 'slack.notification_channel')"
                    :key="row.key"
                    class="flex flex-col gap-2"
                  >
                    <label for="slack-notify-in-card" class="text-sm font-medium"
                      >Post notifications to</label
                    >
                    <p class="text-sm text-muted">
                      The toasts you keep on, under Notifications, also go here.
                    </p>
                    <SlackDestination
                      id="slack-notify-in-card"
                      :setting="row.key"
                      :value="row.value"
                      :choices="slackDestinations"
                      @choose="(value) => set(row, value)"
                    />
                    <p v-if="refusals[idOf(row)]" class="text-sm text-error" role="alert">
                      {{ refusals[idOf(row)] }}
                    </p>
                    <p class="text-xs" :class="metaOf(row).tone" role="status">
                      {{ metaOf(row).said }}
                    </p>
                  </div>
                </template>
              </SettingsConnections>
            </section>

            <section
              v-if="showOwn"
              id="machine-own"
              aria-labelledby="machine-own-title"
              class="flex flex-col gap-4"
              data-testid="machine-own"
            >
              <div class="flex flex-col gap-2">
                <h2 id="machine-own-title" class="text-lg font-semibold">Each Machine's own</h2>
                <p class="text-sm text-muted">
                  Where its projects live, its Native chat's harness, and the answers it remembered
                  stay in that Machine's config.json. Change them in that Machine's TUI Settings.
                </p>
              </div>
              <MachineOwnTable :rows="own" />
              <div>
                <UButton
                  color="neutral"
                  variant="outline"
                  label="Open Machines"
                  @click="openPage('machines')"
                />
              </div>
            </section>
            <section v-if="showAbout" id="about" class="flex flex-col gap-3" data-testid="about">
              <h3 class="text-sm font-semibold">About</h3>
              <DesktopVersion />
            </section>
          </main>
        </div>
      </div>
    </div>
  </section>
</template>
