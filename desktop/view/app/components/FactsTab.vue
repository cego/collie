<script setup lang="ts">
import type { RunDetail, TaskView } from "../../../../src/board-model";
import { attachmentsShown } from "../../../src/shared/attachments";
import { agentRows } from "../../../src/shared/run-agents";

const props = defineProps<{ task: TaskView; detail: RunDetail | null; installation: string }>();
const attached = computed(() => attachmentsShown(props.detail?.attachments ?? []));
const agents = computed(() => agentRows(props.detail?.agents ?? []));
</script>

<template>
  <div data-testid="facts" class="flex flex-col gap-4 text-sm">
    <section
      v-if="detail && attached.thumbnails.length + attached.named.length > 0"
      class="flex flex-col gap-2"
      data-testid="attachments"
    >
      <h3 class="font-semibold">Attachments</h3>
      <div
        v-if="attached.thumbnails.length > 0"
        class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
      >
        <EvidenceImage
          v-for="file in attached.thumbnails"
          :key="file.name"
          :file="file"
          kind="attachment"
          :installation="installation"
          :run-id="detail.id"
        />
      </div>
      <p
        v-for="file in attached.named"
        :key="file.name"
        :data-testid="`attachment-${file.name}`"
        class="flex justify-between gap-2"
      >
        <span class="truncate">{{ file.name }}</span>
        <small class="text-muted">{{ file.mediaType }} · {{ file.size }} bytes</small>
      </p>
    </section>

    <section v-if="agents.length > 0" data-testid="agents">
      <h3 class="font-semibold">Agents</h3>
      <p v-for="row in agents" :key="row.key" class="flex justify-between gap-2">
        <span>
          <strong>{{ row.operation }}</strong> {{ row.ranOn }}
        </span>
        <small class="truncate text-muted">{{ row.agent }}</small>
      </p>
    </section>
    <section v-if="detail?.intent" data-testid="intent">
      <h3 class="font-semibold">Intent</h3>
      <p v-if="detail.intent.goal">{{ detail.intent.goal }}</p>
      <ul class="list-disc pl-5">
        <li v-for="(constraint, at) in detail.intent.constraints" :key="at">{{ constraint }}</li>
      </ul>
    </section>
    <section v-if="detail && detail.steering.length > 0" data-testid="steering">
      <h3 class="font-semibold">Steering</h3>
      <ul class="flex flex-col gap-2">
        <li
          v-for="card in detail.steering"
          :key="card.id"
          class="rounded border border-default p-2"
          :data-testid="`steering-${card.id}`"
        >
          <div class="flex flex-wrap gap-2">
            <strong>{{ card.kind }}</strong>
            <UBadge variant="subtle" :label="card.readiness" />
            <UBadge variant="outline" color="neutral" :label="card.significance" />
            <small class="text-muted">{{ card.at }}</small>
          </div>
          <p v-if="card.narrative">{{ card.narrative }}</p>
          <p v-if="card.missing.length > 0" class="text-warning">
            Missing: {{ card.missing.join(", ") }}
          </p>
        </li>
      </ul>
    </section>
    <section data-testid="taskview">
      <h3 class="font-semibold">TaskView</h3>
      <pre class="overflow-auto rounded bg-elevated p-2 text-xs">{{
        JSON.stringify(task, null, 2)
      }}</pre>
    </section>
  </div>
</template>
