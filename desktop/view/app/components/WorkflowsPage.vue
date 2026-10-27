<script setup lang="ts">
import { Exit, type Schema } from "effect";
import type { HostDefinitions } from "../../../../src/definitions-model";
import { failureOf } from "../../../src/shared/actions";
import { offersOf, shownAs } from "../../../src/shared/definitions-view";
import type { Token } from "../composables/useHighlight";

/** One view for the Flock, read-only: In sync Machines share their definitions. */
const emit = defineEmits<{ back: [] }>();
const { machines } = useFlock();
const { definitionsOf } = useActions();

// Mounted each time the page opens, so each opening reads again.
const machine = machines.value.find(({ local }) => local) ?? machines.value[0];
const read = ref<HostDefinitions | null>(null);
const failed = ref<string | null>(machine === undefined ? "No Machine is connected" : null);
onMounted(async () => {
  if (machine === undefined) return;
  const exit = await definitionsOf(machine.installation);
  if (Exit.isSuccess(exit)) read.value = exit.value;
  else failed.value = failureOf(exit.cause).reason;
});

const chosen = ref<{ kind: "workflow" | "persona"; id: string } | null>(null);
const workflow = computed(() =>
  chosen.value?.kind === "workflow"
    ? read.value?.workflows.find(({ id }) => id === chosen.value?.id)
    : undefined,
);
const persona = computed(() =>
  chosen.value?.kind === "persona"
    ? read.value?.personas.find(({ name }) => name === chosen.value?.id)
    : undefined,
);
const isChosen = (kind: "workflow" | "persona", id: string) =>
  chosen.value?.kind === kind && chosen.value.id === id;
const offers = computed(() => (workflow.value ? offersOf(workflow.value.metadata) : []));

const detail = useTemplateRef("detail");
watch(chosen, () => detail.value?.scrollTo({ top: 0 }));
const jumpTo = (section: string) =>
  document.getElementById(section)?.scrollIntoView({ block: "start", behavior: "smooth" });

const files = shallowRef<
  ReadonlyArray<{
    path: string;
    text: string;
    lines: ReadonlyArray<ReadonlyArray<Token>> | null;
  }>
>([]);
watch(workflow, async (now, _, onCleanup) => {
  let stale = false;
  onCleanup(() => (stale = true));
  files.value = (now?.files ?? []).map((file) => ({ ...file, lines: null }));
  const coloured = await Promise.all(
    (now?.files ?? []).map(async (file) => ({
      ...file,
      lines:
        shownAs(file.path) === "code"
          ? await highlightLines(file.text.split("\n"), file.path)
          : null,
    })),
  );
  if (!stale) files.value = coloured;
});

const json = (value: typeof Schema.Json.Type | null) => JSON.stringify(value, null, 2);
const ENTRY =
  "flex w-full flex-col gap-1 border-l-2 px-4 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary";
const entryClass = (chosen: boolean) =>
  chosen ? "border-primary bg-elevated" : "border-transparent hover:bg-elevated/50";
const HEADING =
  "sticky top-0 z-10 flex items-center justify-between border-b border-default bg-default px-4 py-2 text-xs font-semibold tracking-wide text-muted uppercase";
const LABEL = "text-xs font-semibold tracking-wide text-muted uppercase";
const SCHEMA = "rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere";
</script>

<template>
  <section data-testid="workflows-page" class="flex flex-col overflow-hidden bg-default">
    <PageHeader title="Workflows" page="workflows" @back="emit('back')">
      <p v-if="machine" class="text-sm text-muted" data-testid="read-from">
        Read from {{ machine.name }}
      </p>
    </PageHeader>
    <p v-if="failed !== null" class="p-4 text-sm text-error" data-testid="read-failed">
      {{ failed }}
    </p>
    <p v-else-if="read === null" class="p-4 text-sm text-muted">Reading…</p>
    <div v-else class="flex min-h-0 flex-1">
      <nav
        class="flex w-[clamp(15rem,32%,24rem)] shrink-0 flex-col border-r border-default"
        aria-label="Workflows and Personas"
      >
        <div class="flex shrink-0 gap-1 border-b border-default px-2 py-1.5">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            label="Workflows"
            @click="jumpTo('workflows-list')"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            label="Personas"
            data-testid="jump-personas"
            @click="jumpTo('personas-list')"
          />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <section id="workflows-list">
            <h3 :class="HEADING">
              Workflows <span class="tabular-nums">{{ read.workflows.length }}</span>
            </h3>
            <ul>
              <li v-for="one in read.workflows" :key="one.id">
                <button
                  type="button"
                  :data-testid="`workflow-${one.id}`"
                  :aria-pressed="isChosen('workflow', one.id)"
                  :class="[ENTRY, entryClass(isChosen('workflow', one.id))]"
                  @click="chosen = { kind: 'workflow', id: one.id }"
                >
                  <strong class="text-sm leading-snug font-semibold text-highlighted">
                    {{ one.title }}
                  </strong>
                  <span class="flex flex-wrap items-center gap-1.5">
                    <code class="text-xs text-muted">{{ one.id }}</code>
                    <UBadge size="sm" variant="subtle" color="neutral" :label="one.layer" />
                    <UBadge
                      v-if="one.broken !== null"
                      size="sm"
                      variant="subtle"
                      color="error"
                      label="Won't construct"
                    />
                  </span>
                  <span class="line-clamp-2 text-xs text-muted">{{ one.description }}</span>
                </button>
              </li>
            </ul>
          </section>
          <section v-if="read.problems.length > 0">
            <h3 :class="[HEADING, 'text-warning']">Would not load</h3>
            <p
              v-for="problem in read.problems"
              :key="problem.path"
              class="px-4 py-2 text-xs break-all"
            >
              <code>{{ problem.path }}</code>
              <span class="block break-normal text-muted">{{ problem.message }}</span>
            </p>
          </section>
          <section id="personas-list">
            <h3 :class="HEADING">
              Personas <span class="tabular-nums">{{ read.personas.length }}</span>
            </h3>
            <ul>
              <li v-for="one in read.personas" :key="one.name">
                <button
                  type="button"
                  :data-testid="`persona-${one.name}`"
                  :aria-pressed="isChosen('persona', one.name)"
                  :class="[ENTRY, entryClass(isChosen('persona', one.name))]"
                  @click="chosen = { kind: 'persona', id: one.name }"
                >
                  <span class="flex flex-wrap items-center gap-1.5">
                    <strong class="text-sm font-semibold text-highlighted">{{ one.name }}</strong>
                    <UBadge size="sm" variant="subtle" color="neutral" :label="one.layer" />
                  </span>
                  <span class="line-clamp-2 text-xs text-muted">{{ one.description }}</span>
                </button>
              </li>
            </ul>
          </section>
          <section v-if="read.errors.length > 0">
            <h3 :class="[HEADING, 'text-warning']">Personas that would not load</h3>
            <p v-for="error in read.errors" :key="error" class="px-4 py-2 text-xs text-muted">
              {{ error }}
            </p>
          </section>
        </div>
      </nav>

      <div
        ref="detail"
        class="@container/detail min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        <article
          v-if="workflow"
          class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-6"
          data-testid="workflow"
        >
          <header class="flex flex-col gap-2">
            <h2 class="text-2xl font-semibold text-highlighted">{{ workflow.title }}</h2>
            <p class="text-default">{{ workflow.description }}</p>
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <UBadge size="sm" variant="subtle" color="neutral" :label="workflow.layer" />
              <code>{{ workflow.id }}</code>
              <span>·</span>
              <code class="break-all">{{ workflow.path }}</code>
            </p>
          </header>
          <UAlert
            v-if="workflow.broken !== null"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            title="Won't construct"
            :description="workflow.broken"
          />

          <section class="flex flex-col gap-3">
            <h3 :class="LABEL">Inputs</h3>
            <p v-if="workflow.inputs.length === 0" class="text-sm text-muted">None</p>
            <div
              v-for="input in workflow.inputs"
              :key="input.name"
              class="flex flex-col gap-2 rounded-md border border-default p-3"
            >
              <p class="flex flex-wrap items-center gap-2">
                <code class="font-semibold">{{ input.name }}</code>
                <UBadge
                  size="sm"
                  variant="subtle"
                  :color="input.required ? 'primary' : 'neutral'"
                  :label="input.required ? 'required' : 'optional'"
                />
                <span v-if="input.strategy !== null" class="text-xs text-muted">
                  inferred by {{ input.strategy }}
                </span>
              </p>
              <pre :class="SCHEMA">{{ json(input.schema) }}</pre>
              <p v-for="limit in input.limits" :key="limit" class="text-xs text-muted">
                {{ limit }}
              </p>
            </div>
          </section>

          <section class="flex flex-col gap-3" data-testid="offers">
            <h3 :class="LABEL">Offers</h3>
            <p v-if="offers.length === 0" class="text-sm text-muted">None</p>
            <ul
              v-else
              class="flex flex-col divide-y divide-default rounded-md border border-default"
            >
              <li
                v-for="offer in offers"
                :key="offer.id"
                class="flex flex-wrap items-baseline gap-x-2 px-3 py-2 text-sm"
              >
                <strong class="font-medium">{{ offer.title }}</strong>
                <span class="text-muted">
                  starts <code>{{ offer.workflow }}</code> {{ offer.when }}
                </span>
              </li>
            </ul>
          </section>

          <div class="grid grid-cols-1 gap-8 @3xl/detail:grid-cols-2">
            <section
              v-for="[label, drawn] in [
                ['Result', workflow.success],
                ['Failure', workflow.error],
              ] as const"
              :key="label"
              class="flex min-w-0 flex-col gap-3"
            >
              <h3 :class="LABEL">{{ label }}</h3>
              <pre :class="SCHEMA">{{ json(drawn.schema) }}</pre>
              <p v-for="limit in drawn.limits" :key="limit" class="text-xs text-muted">
                {{ limit }}
              </p>
            </section>
          </div>

          <section class="flex flex-col gap-3">
            <h3 :class="LABEL">Settled by the host</h3>
            <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <template v-for="option in workflow.options" :key="option.name">
                <dt>
                  <code>{{ option.name }}</code>
                </dt>
                <dd class="text-muted">{{ option.meaning }}</dd>
              </template>
            </dl>
          </section>

          <details class="group">
            <summary :class="[LABEL, 'cursor-pointer']">Metadata</summary>
            <pre :class="[SCHEMA, 'mt-3']">{{ json(workflow.metadata) }}</pre>
          </details>

          <section
            v-for="file in files"
            :key="file.path"
            class="overflow-hidden rounded-md border border-default"
            data-testid="workflow-file"
          >
            <code class="block bg-muted px-3 py-2 text-xs break-all">{{ file.path }}</code>
            <div v-if="shownAs(file.path) === 'markdown'" class="border-t border-default px-4 py-3">
              <RichMarkdown :text="file.text" />
            </div>
            <div v-else class="overflow-x-auto border-t border-default" data-highlighted>
              <p v-if="file.lines === null" class="p-3 text-sm text-muted">Highlighting…</p>
              <table v-else class="w-full font-mono text-xs">
                <tr v-for="(tokens, at) in file.lines" :key="at">
                  <td class="w-10 px-2 text-right text-muted select-none">{{ at + 1 }}</td>
                  <td class="px-2 whitespace-pre"><TokenSpans :tokens="tokens" /></td>
                </tr>
              </table>
            </div>
          </section>
        </article>

        <article
          v-else-if="persona"
          class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6"
          data-testid="persona"
        >
          <header class="flex flex-col gap-2 border-b border-default pb-6">
            <h2 class="text-2xl font-semibold text-highlighted">{{ persona.name }}</h2>
            <p class="text-default">{{ persona.description }}</p>
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <UBadge size="sm" variant="subtle" color="neutral" :label="persona.layer" />
              <code class="break-all">{{ persona.path }}</code>
              <template v-if="persona.extends !== null">
                <span>·</span>
                <span>extends {{ persona.extends }}</span>
              </template>
            </p>
          </header>
          <RichMarkdown :text="persona.body" class="[&_.comark-content>:first-child]:mt-0" />
        </article>

        <div v-else class="flex h-full items-center justify-center p-6">
          <UEmpty
            icon="i-lucide-workflow"
            title="Choose a Workflow or a Persona to read it"
            :description="`A Workflow shows its Inputs, what it gives back, what it offers next and its files. A Persona shows its instructions. ${read.workflows.length} Workflows and ${read.personas.length} Personas are read from ${machine?.name ?? 'this Machine'}.`"
            variant="naked"
            class="max-w-md"
            data-testid="nothing-chosen"
          />
        </div>
      </div>
    </div>
  </section>
</template>
