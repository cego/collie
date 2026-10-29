<script setup lang="ts">
/** Takes the GitLab token or Helle's token, kept once for every Machine. */
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Str from "effect/String";
const props = defineProps<{ which: "gitlab" | "helle"; label: string }>();
const emit = defineEmits<{ saved: [] }>();
const { saveGitlab, saveHelle, checkHelle, openSlack, copyText } = useActions();
const { credentials } = useCredentials();

const HELLE_COMMAND = "/helle token";
const token = ref("");
/** What Helle said of the token last pasted. */
const check = ref<{ token: string; owner?: string; refused?: string } | null>(null);
watch(token, (now, _, onCleanup) => {
  const said = Str.trim(now);
  check.value = null;
  if (props.which !== "helle" || said === "") return;
  // Asked once typing stops, not of every keystroke.
  const asking = Effect.runFork(
    Effect.gen(function* () {
      const answer = yield* Effect.promise(() => checkHelle(said));
      if (Str.trim(token.value) === said) check.value = { token: said, ...answer };
    }).pipe(
      // Clearing the old timer never cancelled an already started request.
      Effect.uninterruptible,
      Effect.delay("400 millis"),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
      ),
    ),
  );
  onCleanup(() => {
    Effect.runFork(Fiber.interrupt(asking));
  });
});
const accepted = computed(
  () =>
    props.which === "gitlab" ||
    (check.value?.token === Str.trim(token.value) && check.value.owner !== undefined),
);
const keep = () => {
  return Effect.runPromise(
    Effect.gen(function* () {
      const said = Str.trim(token.value);
      const kept = yield* Effect.promise(() =>
        props.which === "gitlab" ? saveGitlab(said) : saveHelle(said),
      );
      if (!kept) return;
      token.value = "";
      emit("saved");
    }),
  );
};
</script>

<template>
  <div class="flex flex-col gap-2">
    <ol v-if="which === 'helle'" class="flex flex-col gap-1 text-sm" data-testid="helle-guide">
      <li class="flex items-center gap-2">
        1.
        <UButton
          size="xs"
          variant="outline"
          icon="i-lucide-external-link"
          label="Open Slack"
          data-testid="helle-slack"
          @click="openSlack"
        />
      </li>
      <li class="flex items-center gap-2">
        2. Run <code>{{ HELLE_COMMAND }}</code>
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-copy"
          :aria-label="`Copy ${HELLE_COMMAND}`"
          data-testid="helle-copy"
          @click="copyText(HELLE_COMMAND)"
        />
      </li>
      <li>3. Press <strong>Create new token</strong> and label it, for example “Collie”.</li>
      <li>4. Paste the token here.</li>
    </ol>
    <form class="flex gap-2" :data-testid="`${which}-fields`" @submit.prevent="keep">
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
        :disabled="Str.trim(token) === '' || !accepted"
      />
    </form>
    <p
      v-if="which === 'helle' && check?.token === Str.trim(token)"
      class="text-sm"
      :class="check.owner === undefined ? 'text-error' : 'text-success'"
      data-testid="helle-check"
    >
      {{ check.owner === undefined ? check.refused : `Belongs to ${check.owner}` }}
    </p>
  </div>
</template>
