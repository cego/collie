// What the human set in Desktop, as the main process tells every window of it.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { DesktopSettings, DesktopSettingsChange } from "../../../src/shared/flock";
import { desktopSettingsAtom, FlockClient } from "../flock";
import { failureOf } from "./useActions";

const setSettingsAtom = FlockClient.mutation("setSettings");

const UNTOLD: DesktopSettings = { proactive: true };

export const useDesktopSettings = () => {
  const { value } = useHeld(() => desktopSettingsAtom);
  const writeSettings = useAtomSet(() => setSettingsAtom, { mode: "promiseExit" });
  /** Why the change was refused, or null where it was kept. */
  const change = (changed: DesktopSettingsChange) =>
    writeSettings({ payload: changed }).then((exit) =>
      Exit.isFailure(exit) ? failureOf(exit.cause).reason : null,
    );
  return {
    desktopSettings: computed(() => value.value ?? UNTOLD),
    change,
    /** Lets the Flock chat speak first about News that matters, or not. */
    setProactive: (proactive: boolean) => change({ proactive }),
  };
};
