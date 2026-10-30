import { useAtomSet } from "@effect/atom-vue";
import { Cause, Exit } from "effect";
import { rememberCatalogues, type MachineCatalogue } from "../../../src/shared/settings-agents";
import { FlockClient } from "../flock";

const cataloguesAtom = FlockClient.mutation("catalogues");
const machines = shallowRef<ReadonlyArray<MachineCatalogue>>([]);
let asks = 0;

export const useCatalogues = () => {
  const ask = useAtomSet(() => cataloguesAtom, { mode: "promiseExit" });
  const problem = ref<string | null>(null);
  const refresh = () => {
    const requested = ++asks;
    machines.value = rememberCatalogues(machines.value, [], rows.value);
    return ask({ payload: undefined }).then((exit) => {
      if (requested !== asks) return;
      if (Exit.isSuccess(exit)) {
        machines.value = rememberCatalogues(machines.value, exit.value, rows.value);
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
