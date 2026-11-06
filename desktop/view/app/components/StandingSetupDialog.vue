<script setup lang="ts">
import type { OwnSource } from "../../../../src/own-words-model";
import type { ComputerStores } from "../../../src/shared/standing-setup";

const { open, inventory, decline, choose } = useStandingSetup();
const toast = useToast();

const SOURCES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
  collie: "Collie's records",
} satisfies Record<OwnSource, string>;

const found = ref<ReadonlyArray<ComputerStores> | null>(null);
watch(open, (isOpen) => {
  if (!isOpen) return;
  found.value = null;
  void inventory().then((stores) => {
    found.value = stores;
  });
});

const declined = (forGood: boolean) =>
  decline(forGood).then((refused) => {
    if (refused !== null) toast.add({ title: refused, color: "error" });
  });
</script>

<template>
  <UModal v-model:open="open" title="Tell Collie how you work">
    <template #body>
      <div class="flex flex-col gap-4" data-testid="standing-setup">
        <p>
          Collie can draft your Standing direction from the messages you typed to your coding
          agents, or ask you five questions instead. Nothing is saved until you accept the draft.
        </p>
        <p v-if="found === null" class="text-muted">Looking for your sessions…</p>
        <ul v-else class="flex flex-col gap-2 text-sm" data-testid="standing-setup-found">
          <li v-for="computer in found" :key="computer.computer">
            <span class="font-medium">{{ computer.computer }}</span>
            <span v-if="computer.problem" class="text-warning">: {{ computer.problem }}</span>
            <ul v-else class="ms-4 list-disc">
              <li v-for="store in computer.stores" :key="store.source">
                {{ SOURCES[store.source] }}:
                <template v-if="store.found === 'read'">
                  {{ store.sessions }} {{ store.source === "collie" ? "entries" : "sessions" }} in
                  <code>{{ store.where }}</code>
                </template>
                <span v-else class="text-muted"
                  >{{ store.found }}{{ store.why ? `: ${store.why}` : "" }}</span
                >
              </li>
            </ul>
          </li>
        </ul>
        <p class="text-sm text-muted">
          What is read goes to the Flock chat's model provider, for this one conversation. Your
          consent is not kept: the next setup asks again.
        </p>
        <div class="flex flex-wrap justify-end gap-2">
          <UButton
            label="Don't ask again"
            color="neutral"
            variant="ghost"
            data-testid="standing-setup-never"
            @click="declined(true)"
          />
          <UButton
            label="Not now"
            color="neutral"
            variant="ghost"
            data-testid="standing-setup-not-now"
            @click="declined(false)"
          />
          <UButton
            label="Ask me five questions instead"
            color="neutral"
            variant="outline"
            data-testid="standing-setup-ask"
            @click="choose('ask')"
          />
          <UButton
            label="Read my messages"
            data-testid="standing-setup-read"
            :disabled="found === null"
            @click="choose('read')"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
