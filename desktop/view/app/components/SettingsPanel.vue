<script setup lang="ts">
import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import { NO_FLOCK_SETTINGS, settingRows } from "../../../src/shared/flock-settings";
import { flockSettingsAtom } from "../flock";

const open = defineModel<boolean>("open", { required: true });
const { openLink, saveGitlabHost, setFlockSetting } = useActions();
const { credentials } = useCredentials();
const held = useAtomValue(() => flockSettingsAtom);
const rows = computed(() =>
  settingRows(AsyncResult.getOrElse(held.value, () => NO_FLOCK_SETTINGS)),
);

const host = ref("");
const saveHost = async () => {
  if (await saveGitlabHost(host.value.trim())) host.value = "";
};

/** What is typed into a field, until it is set. */
const drafts = ref<Record<string, string>>({});
const shown = (key: string, value: string) => drafts.value[key] ?? value;
const set = async (key: string, value: string) => {
  if (await setFlockSetting(key, value)) delete drafts.value[key];
};
</script>

<template>
  <USlideover v-model:open="open" title="Settings">
    <template #body>
      <div class="flex flex-col gap-6">
        <section v-if="credentials" class="flex flex-col gap-3" data-testid="credentials">
          <h3 class="text-sm font-semibold">Shared by every Machine</h3>
          <form class="flex gap-2" data-testid="gitlab-host-form" @submit.prevent="saveHost">
            <UInput
              v-model="host"
              class="flex-1"
              :placeholder="`GitLab host: ${credentials.host}`"
              data-testid="gitlab-host"
            />
            <UButton
              type="submit"
              size="sm"
              label="Use this GitLab"
              data-testid="save-gitlab-host"
              :disabled="host.trim() === ''"
            />
          </form>
          <div class="flex items-center gap-2">
            <span class="font-medium">GitLab token</span>
            <span class="text-sm text-muted" data-testid="gitlab-state">
              {{
                credentials.gitlab === null
                  ? "none yet"
                  : credentials.gitlab.expires === null
                    ? "kept"
                    : `expires ${credentials.gitlab.expires}`
              }}
            </span>
            <UButton
              class="ml-auto"
              size="xs"
              variant="outline"
              icon="i-lucide-external-link"
              label="Make one on GitLab"
              data-testid="token-page"
              @click="openLink(credentials.tokenPage)"
            />
          </div>
          <CredentialFields
            which="gitlab"
            :label="credentials.gitlab === null ? 'Save' : 'Renew'"
          />
          <div class="flex items-center gap-2">
            <span class="font-medium">Helle</span>
            <span class="text-sm text-muted" data-testid="helle-state">
              {{ credentials.helle ? "kept" : "none yet" }}
            </span>
          </div>
          <CredentialFields which="helle" label="Save" />
        </section>
        <section class="flex flex-col gap-3" data-testid="collie-settings">
          <h3 class="text-sm font-semibold">Collie</h3>
          <p class="text-sm text-muted">Every Machine gets these; the latest edit of each wins.</p>
          <UFormField
            v-for="row in rows"
            :key="row.key"
            :label="row.key"
            :help="row.fallback === '' ? 'Unset: the harness decides' : `Default: ${row.fallback}`"
            :hint="row.from === null ? undefined : `from ${row.from}`"
            :data-testid="`setting-${row.key}`"
          >
            <div class="flex gap-2">
              <USelect
                v-if="row.kind === 'choice'"
                class="flex-1"
                :model-value="row.value === '' ? undefined : row.value"
                :items="[...row.choices]"
                :placeholder="row.fallback"
                @update:model-value="(chosen) => set(row.key, String(chosen))"
              />
              <USwitch
                v-else-if="row.kind === 'boolean'"
                class="flex-1"
                :model-value="(row.value || row.fallback) === 'true'"
                @update:model-value="(on) => set(row.key, String(on))"
              />
              <form
                v-else
                class="flex flex-1 gap-2"
                @submit.prevent="set(row.key, shown(row.key, row.value))"
              >
                <UInput
                  class="flex-1"
                  :type="row.kind === 'number' ? 'number' : 'text'"
                  :model-value="shown(row.key, row.value)"
                  :placeholder="row.kind === 'list' ? 'none, or a, b' : row.fallback"
                  @update:model-value="(typed) => (drafts[row.key] = String(typed))"
                />
                <UButton
                  type="submit"
                  size="sm"
                  label="Set"
                  :disabled="shown(row.key, row.value) === row.value"
                />
              </form>
              <UButton
                v-if="row.value !== ''"
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-rotate-ccw"
                :aria-label="`Unset ${row.key}`"
                @click="set(row.key, '')"
              />
            </div>
          </UFormField>
        </section>
      </div>
    </template>
  </USlideover>
</template>
