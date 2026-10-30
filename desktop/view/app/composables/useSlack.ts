import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { SlackChoices } from "../../../../src/slack";
import { failureOf } from "../../../src/shared/actions";
import { FlockClient } from "../flock";

const choicesAtom = FlockClient.mutation("slackChoices");
export const useSlack = () => {
  const ask = useAtomSet(() => choicesAtom, { mode: "promiseExit" });
  const choices = shallowRef<SlackChoices | null>(null);
  const trouble = ref<string | null>(null);
  const loading = ref(false);
  let requested = 0;
  const refresh = () => {
    const mine = ++requested;
    loading.value = true;
    return ask({ payload: undefined }).then((exit) => {
      if (mine !== requested) return;
      loading.value = false;
      choices.value = Exit.isSuccess(exit) ? exit.value : null;
      trouble.value = Exit.isFailure(exit) ? failureOf(exit.cause).reason : null;
    });
  };
  return { choices, trouble, loading, refresh };
};
