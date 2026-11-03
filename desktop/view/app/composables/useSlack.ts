import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { SlackChannel } from "../../../../src/slack";
import { FlockClient } from "../flock";

const yoursAtom = FlockClient.mutation("slackUserChannels");
export const useSlack = () => {
  const askYours = useAtomSet(() => yoursAtom, { mode: "promiseExit" });
  const yours = shallowRef<ReadonlyArray<typeof SlackChannel.Type> | null>(null);
  const loading = ref(false);
  let requested = 0;
  const refresh = () => {
    const mine = ++requested;
    loading.value = true;
    return askYours({ payload: undefined }).then((exit) => {
      if (mine !== requested) return;
      loading.value = false;
      yours.value = Exit.isSuccess(exit) ? exit.value : null;
    });
  };
  return { yours, loading, refresh };
};
