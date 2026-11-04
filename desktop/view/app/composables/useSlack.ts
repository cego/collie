import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { SlackChannel, SlackChoices } from "../../../../src/slack";
import { failureOf } from "../../../src/shared/actions";
import { FlockClient } from "../flock";

const choicesAtom = FlockClient.mutation("slackChoices");
const yoursAtom = FlockClient.mutation("slackUserChannels");
export const useSlack = () => {
  const ask = useAtomSet(() => choicesAtom, { mode: "promiseExit" });
  const askYours = useAtomSet(() => yoursAtom, { mode: "promiseExit" });
  const choices = shallowRef<SlackChoices | null>(null);
  const yours = shallowRef<ReadonlyArray<typeof SlackChannel.Type> | null>(null);
  const trouble = ref<string | null>(null);
  const loading = ref(false);
  let requested = 0;
  const refresh = () => {
    const mine = ++requested;
    loading.value = true;
    return Promise.all([ask({ payload: undefined }), askYours({ payload: undefined })]).then(
      ([exit, yoursExit]) => {
        if (mine !== requested) return;
        loading.value = false;
        choices.value = Exit.isSuccess(exit) ? exit.value : null;
        trouble.value = Exit.isFailure(exit) ? failureOf(exit.cause).reason : null;
        yours.value = Exit.isSuccess(yoursExit) ? yoursExit.value : null;
      },
    );
  };
  return { choices, yours, trouble, loading, refresh };
};
