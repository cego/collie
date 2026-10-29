import { useAtomSet } from "@effect/atom-vue";
import { Cause, Exit } from "effect";
import type { MachineCatalogue } from "../../../src/shared/settings-agents";
import { FlockClient } from "../flock";

const cataloguesAtom = FlockClient.mutation("catalogues");

export const useCatalogues = () => {
  const ask = useAtomSet(() => cataloguesAtom, { mode: "promiseExit" });
  const machines = shallowRef<ReadonlyArray<MachineCatalogue>>([]);
  const problem = ref<string | null>(null);
  let asks = 0;
  const refresh = () => {
    const requested = ++asks;
    return ask({ payload: undefined }).then((exit) => {
      if (requested !== asks) return;
      if (Exit.isSuccess(exit)) {
        machines.value = exit.value;
        problem.value = null;
      } else problem.value = Cause.pretty(exit.cause);
    });
  };
  const { now, rows } = useFlock();
  watch(
    [now, () => rows.value.map(({ profile, state }) => `${profile}:${state}`).join(",")],
    () => {
      void refresh();
    },
    { immediate: true },
  );
  return { machines: readonly(machines), problem: readonly(problem) };
};
