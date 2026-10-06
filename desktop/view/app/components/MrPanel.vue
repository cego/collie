<script setup lang="ts">
import type { MrPanel } from "../../../../src/board-model";

defineProps<{ mr: MrPanel }>();
const { openLink } = useActions();
</script>

<template>
  <div data-testid="mr" class="flex flex-col gap-3 text-sm">
    <p v-if="mr._tag === 'Unavailable'" class="text-muted">{{ mr.reason }}</p>
    <template v-else>
      <div class="flex items-start justify-between gap-2">
        <strong data-testid="mr-title">!{{ mr.iid }} {{ mr.title }}</strong>
        <UBadge variant="subtle" data-testid="mr-state" :label="mr.state" />
      </div>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt class="text-muted">Pipeline</dt>
        <dd data-testid="mr-pipeline">{{ mr.pipeline || "none" }}</dd>
        <dt class="text-muted">Approvals</dt>
        <dd data-testid="mr-approvals">{{ mr.approvals }}</dd>
        <dt class="text-muted">Comments</dt>
        <dd data-testid="mr-comments">
          {{ mr.notes }}{{ mr.unresolved ? " · a discussion is unresolved" : "" }}
        </dd>
        <dt class="text-muted">Branch</dt>
        <dd>{{ mr.sourceBranch }} → {{ mr.targetBranch }}</dd>
      </dl>
      <UButton
        v-if="mr.url"
        class="self-start"
        size="sm"
        icon="i-lucide-external-link"
        label="Open in browser"
        data-testid="mr-open"
        @click="openLink(mr.url)"
      />
    </template>
  </div>
</template>
