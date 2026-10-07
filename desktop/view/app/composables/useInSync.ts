// Each Machine's In sync verdict against this Desktop's version and credentials, and the
// Flock's line.

import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import type { Credential } from "../../../src/shared/flock";
import { flockInSync, inSync } from "../../../src/shared/in-sync";
import { updatesAtom } from "../flock";

export const useInSync = () => {
  const { rows } = useFlock();
  const { credentials } = useCredentials();
  const updates = useAtomValue(() => updatesAtom);
  const version = computed(() =>
    AsyncResult.isSuccess(updates.value) ? updates.value.value.version : null,
  );
  const held = computed((): ReadonlyArray<Credential> | null => {
    const known = credentials.value;
    if (known === null) return null;
    return [
      ...(known.gitlab === null ? [] : ["gitlab" as const]),
      ...(known.helle ? ["helle" as const] : []),
    ];
  });
  return {
    /** Each route's row and its verdict, on the parts Desktop's own state is known for. */
    machines: computed(() =>
      rows.value.map((row) => ({
        row,
        verdict: inSync(row, { version: version.value ?? "", credentials: held.value ?? [] }),
      })),
    ),
    summary: computed(() =>
      version.value === null || held.value === null
        ? null
        : flockInSync(rows.value, { version: version.value, credentials: held.value }),
    ),
  };
};
