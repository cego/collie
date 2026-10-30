<script setup lang="ts">
import type { MachineOwnRow } from "../../../src/shared/machine-own";
defineProps<{ rows: ReadonlyArray<MachineOwnRow> }>();
</script>

<template>
  <div
    tabindex="0"
    role="region"
    aria-label="Each Machine's own settings"
    class="overflow-x-auto rounded-lg border border-default"
  >
    <table class="w-full text-left text-sm">
      <caption class="sr-only">
        What each Machine keeps for itself
      </caption>
      <thead class="border-b border-default bg-elevated text-xs text-muted">
        <tr>
          <th
            v-for="column in [
              'Machine',
              'Settings sync',
              'projects.root',
              'chat_harness',
              'Harnesses found',
              'Remembered',
            ]"
            :key="column"
            scope="col"
            class="whitespace-nowrap px-4 py-3 font-medium"
          >
            {{ column }}
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-default">
        <tr v-for="row in rows" :key="row.profile">
          <th scope="row" class="whitespace-nowrap px-4 py-3 align-top font-normal">
            <strong class="font-semibold">{{ row.name }}</strong>
            <div class="text-xs text-dimmed">{{ row.where }}</div>
          </th>
          <td class="min-w-40 px-4 py-3 align-top">
            <span :class="row.sync.tone === 'ok' ? 'text-primary' : 'text-warning'">{{
              row.sync.said
            }}</span>
            <div v-if="row.detail" class="text-xs text-muted" :title="row.readAt ?? undefined">
              {{ row.detail }}
            </div>
          </td>
          <td class="px-4 py-3 align-top">
            <code>{{ row.projectsRoot ?? "—" }}</code>
          </td>
          <td class="px-4 py-3 align-top">
            <code>{{ row.chatHarness ?? "—" }}</code>
          </td>
          <td class="px-4 py-3 align-top text-muted">{{ row.harnesses.join(", ") || "—" }}</td>
          <td class="px-4 py-3 align-top text-muted">
            <div v-for="answer in row.remembered" :key="answer.key">
              <code>{{ answer.key }}</code> = {{ answer.value }}
            </div>
            <span v-if="row.remembered.length === 0">—</span>
          </td>
        </tr>
        <tr v-if="rows.length === 0">
          <td colspan="6" class="px-4 py-3 text-muted">
            No Machines yet. Open Machines to add one.
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
