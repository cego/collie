<script setup lang="ts">
import { AsyncResult, injectRegistry, useAtomValue } from "@effect/atom-vue";
import { settingOf, settingStored } from "../../../../src/settings";
import {
  NO_FLOCK_SETTINGS,
  type SettingRow,
  settingSections,
} from "../../../src/shared/flock-settings";
import { flockSettingsAtom } from "../flock";

const open = defineModel<boolean>("open", { required: true });
const { openLink, saveGitlabHost, setFlockSetting } = useActions();
const { credentials } = useCredentials();
const { desktopSettings, setProactive } = useDesktopSettings();
const toast = useToast();
const held = useAtomValue(() => flockSettingsAtom);
// Asked again on opening, which syncs every connected Machine and so shows their edits.
const registry = injectRegistry();
watch(open, (opened) => {
  if (opened) registry.refresh(flockSettingsAtom);
});
const sections = computed(() =>
  settingSections(
    AsyncResult.getOrElse(held.value, () => NO_FLOCK_SETTINGS),
    desktopSettings.value,
  ),
);

const host = ref("");
const saveHost = async () => {
  if (await saveGitlabHost(host.value.trim())) host.value = "";
};

const idOf = (row: SettingRow) => `${row.shared ? "flock" : "desktop"}-${row.key}`;
/** What is typed into a field, until it is set. */
const drafts = ref<Record<string, string>>({});
const shown = (row: SettingRow) => drafts.value[idOf(row)] ?? row.value;
/** `typed` in the row's unit; empty unsets it. */
const set = async (row: SettingRow, typed: string) => {
  // Desktop's own list is the Flock chat's switch alone.
  if (!row.shared) {
    if (!(await setProactive((typed || row.fallback) === "true")))
      toast.add({ title: "Desktop could not keep that", color: "error" });
    return;
  }
  const stored = settingStored(row.key, typed);
  if ("refused" in stored) return void toast.add({ title: stored.refused, color: "error" });
  if (await setFlockSetting(row.key, stored.stored)) delete drafts.value[idOf(row)];
};
const gitlabHostSaid = settingOf("gitlab_host")?.description;
</script>

<template>
  <USlideover v-model:open="open" title="Settings">
    <template #body>
      <div class="flex flex-col gap-6">
        <section
          v-for="section in sections"
          :key="section.group"
          class="flex flex-col gap-4"
          :data-testid="`settings-${section.group}`"
        >
          <h3 class="text-sm font-semibold">{{ section.group }}</h3>
          <div
            v-for="row in section.rows"
            :key="idOf(row)"
            class="flex flex-col gap-1"
            :data-testid="`setting-${idOf(row)}`"
          >
            <div class="flex items-baseline gap-2">
              <span class="font-medium">{{ row.label }}</span>
              <code class="text-xs text-muted">{{ row.key }}</code>
              <UBadge
                class="ml-auto"
                size="sm"
                variant="subtle"
                :color="row.shared ? 'primary' : 'neutral'"
                :label="row.shared ? 'Every Machine' : 'This computer only'"
              />
            </div>
            <p class="text-sm text-muted">{{ row.description }}</p>
            <div class="flex items-center gap-2">
              <USelect
                v-if="row.kind === 'choice'"
                class="flex-1"
                :model-value="row.value === '' ? undefined : row.value"
                :items="[...row.choices]"
                :placeholder="row.fallback"
                :aria-label="row.label"
                @update:model-value="(chosen) => set(row, String(chosen))"
              />
              <USwitch
                v-else-if="row.kind === 'boolean'"
                :model-value="(row.value || row.fallback) === 'true'"
                :aria-label="row.label"
                @update:model-value="(on) => set(row, String(on))"
              />
              <form
                v-else
                class="flex flex-1 items-center gap-2"
                @submit.prevent="set(row, shown(row))"
              >
                <UInput
                  class="flex-1"
                  :type="row.kind === 'number' ? 'number' : 'text'"
                  :step="row.kind === 'number' ? 'any' : undefined"
                  :model-value="shown(row)"
                  :placeholder="row.kind === 'list' ? 'none, or a, b' : row.fallback"
                  :aria-label="row.label"
                  @update:model-value="(typed) => (drafts[idOf(row)] = String(typed))"
                />
                <span v-if="row.unit" class="text-sm text-muted">{{ row.unit }}</span>
                <UButton type="submit" size="sm" label="Set" :disabled="shown(row) === row.value" />
              </form>
            </div>
            <div class="flex items-center gap-2 text-xs text-muted">
              <span>{{ row.defaultSaid }}</span>
              <span v-if="row.from !== null">from {{ row.from }}</span>
              <UButton
                v-if="row.set"
                class="ml-auto"
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-rotate-ccw"
                label="Reset to default"
                @click="set(row, '')"
              />
            </div>
          </div>
        </section>
        <section class="flex flex-col gap-4" data-testid="credentials">
          <h3 class="text-sm font-semibold">GitLab and credentials</h3>
          <template v-if="credentials">
            <div class="flex flex-col gap-1">
              <div class="flex items-baseline gap-2">
                <span class="font-medium">GitLab host</span>
                <code class="text-xs text-muted">gitlab_host</code>
                <UBadge class="ml-auto" size="sm" variant="subtle" label="Every Machine" />
              </div>
              <p class="text-sm text-muted">{{ gitlabHostSaid }}</p>
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
            </div>
            <div class="flex flex-col gap-1">
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
                <UBadge class="ml-auto" size="sm" variant="subtle" label="Every Machine" />
              </div>
              <p class="text-sm text-muted">
                Logs glab in on every Machine, so Runs can push branches and open merge requests.
                Desktop gives it to each Machine and keeps it on this computer alone.
              </p>
              <div>
                <UButton
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
            </div>
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <span class="font-medium">Helle</span>
                <span class="text-sm text-muted" data-testid="helle-state">
                  {{ credentials.helle ? "kept" : "none yet" }}
                </span>
                <UBadge class="ml-auto" size="sm" variant="subtle" label="Every Machine" />
              </div>
              <p class="text-sm text-muted">
                Lets agents on every Machine reach Helle. Desktop gives it to each Machine's
                credentials file and keeps it on this computer alone.
              </p>
              <CredentialFields which="helle" label="Save" />
            </div>
          </template>
        </section>
        <section class="flex flex-col gap-3" data-testid="about">
          <h3 class="text-sm font-semibold">About</h3>
          <DesktopVersion />
        </section>
      </div>
    </template>
  </USlideover>
</template>
