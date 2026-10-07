// Each Machine's In sync verdict against this Desktop's version, and the Flock's line.

import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import { flockInSync, inSync } from "../../../src/shared/in-sync";
import { updatesAtom } from "../flock";

export const useInSync = () => {
  const { rows } = useFlock();
  const updates = useAtomValue(() => updatesAtom);
  const desktop = computed(() =>
    AsyncResult.isSuccess(updates.value) ? { version: updates.value.value.version } : null,
  );
  return {
    /** Each route's row and its verdict, on version too once Desktop's is known. */
    machines: computed(() =>
      rows.value.map((row) => ({ row, verdict: inSync(row, desktop.value ?? { version: "" }) })),
    ),
    summary: computed(() =>
      desktop.value === null ? null : flockInSync(rows.value, desktop.value),
    ),
  };
};
