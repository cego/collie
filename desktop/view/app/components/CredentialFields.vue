<script setup lang="ts">
/** Takes the GitLab token or Helle's token, kept once for every Machine. */
const props = defineProps<{ which: "gitlab" | "helle"; label: string }>();
const emit = defineEmits<{ saved: [] }>();
const { saveGitlab, saveHelle } = useActions();

const token = ref("");
const keep = async () => {
  const said = token.value.trim();
  const kept = props.which === "gitlab" ? await saveGitlab(said) : await saveHelle(said);
  if (!kept) return;
  token.value = "";
  emit("saved");
};
</script>

<template>
  <form class="flex gap-2" :data-testid="`${which}-fields`" @submit.prevent="keep">
    <UInput
      v-model="token"
      type="password"
      class="flex-1"
      :placeholder="which === 'gitlab' ? 'The token GitLab made' : 'Helle token'"
      :data-testid="`${which}-token`"
    />
    <UButton
      type="submit"
      size="sm"
      :label="label"
      :data-testid="`save-${which}`"
      :disabled="token.trim() === ''"
    />
  </form>
</template>
