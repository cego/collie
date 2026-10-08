// Each connected Machine's Usage readings, asked when Desktop opens, each minute while it is
// shown, and whenever the Machines page opens.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import { type MachineUsage, usageDue, usageEntries } from "../../../src/shared/usage";
import { FlockClient } from "../flock";

const usageAtom = FlockClient.mutation("usage");
const machines = ref<ReadonlyArray<MachineUsage>>([]);
let askedAt: number | null = null;
let asks = 0;

export const useUsage = () => {
  const ask = useAtomSet(() => usageAtom, { mode: "promiseExit" });
  const { now, rows } = useFlock();
  const refresh = () => {
    askedAt = now.value;
    const asked = ++asks;
    return ask({ payload: undefined }).then((exit) => {
      // An answer to an older ask never replaces a newer one's.
      if (asked === asks && Exit.isSuccess(exit)) machines.value = exit.value;
    });
  };
  const shown = () => document.visibilityState === "visible";
  const askIfDue = () => {
    // The clock reads 0 until its first tick.
    if (now.value > 0 && usageDue(askedAt, now.value, shown())) void refresh();
  };
  return {
    machines: readonly(machines),
    /** Of Machines live now, so one that left the Flock leaves the header at once. */
    entries: computed(() => {
      const live = new Set(
        rows.value.filter(({ state }) => state === "live").map(({ profile }) => profile),
      );
      return usageEntries(
        machines.value.filter(({ profile }) => live.has(profile)),
        now.value,
      );
    }),
    refresh,
    /** For the one component that lives as long as the window. */
    keepFresh: () => {
      watch(now, askIfDue, { immediate: true });
      onMounted(() => document.addEventListener("visibilitychange", askIfDue));
      onUnmounted(() => document.removeEventListener("visibilitychange", askIfDue));
    },
  };
};
