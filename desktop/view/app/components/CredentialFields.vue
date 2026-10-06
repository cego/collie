<script setup lang="ts">
/** Takes the GitLab token or Helle's credentials, kept once for every Machine. */
const props = defineProps<{ which: "gitlab" | "helle"; label: string }>();
const emit = defineEmits<{ saved: [] }>();
const { saveGitlab, saveHelle } = useActions();
const { credentials } = useCredentials();

const url = ref("");
const token = ref("");
const keep = async () => {
  const kept =
    props.which === "gitlab"
      ? await saveGitlab(token.value.trim())
      : await saveHelle(url.value.trim(), token.value.trim());
  if (!kept) return;
  url.value = "";
  token.value = "";
  emit("saved");
};
</script>

<template>
  <form class="flex gap-2" :data-testid="`${which}-fields`" @submit.prevent="keep">
    <UInput
      v-if="which === 'helle'"
      v-model="url"
      class="flex-1"
      placeholder="Helle's URL"
      data-testid="helle-url"
    />
    <UInput
      v-model="token"
      type="password"
      class="flex-1"
      :placeholder="
        which === 'gitlab' ? `The token ${credentials?.host ?? 'GitLab'} made` : 'Helle token'
      "
      :data-testid="`${which}-token`"
    />
    <UButton
      type="submit"
      size="sm"
      :label="label"
      :data-testid="`save-${which}`"
      :disabled="token.trim() === '' || (which === 'helle' && url.trim() === '')"
    />
  </form>
</template>
