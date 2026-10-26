// What the human set in Desktop, as the main process tells every window, for the chat's bell
// and Settings alike.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { DesktopSettings, DesktopSettingsChange } from "../../../src/shared/flock";
import { desktopSettingsAtom, FlockClient } from "../flock";
import { failureOf } from "./useActions";

const setSettingsAtom = FlockClient.mutation("setSettings");

const UNREAD: DesktopSettings = { proactive: true };

export const useDesktopSettings = () => {
  const writeSettings = useAtomSet(() => setSettingsAtom, { mode: "promiseExit" });
  const { value } = useHeld(() => desktopSettingsAtom);
  /** Why the change was refused, or null where it was kept. */
  const change = (changed: DesktopSettingsChange) =>
    writeSettings({ payload: changed }).then((exit) =>
      Exit.isFailure(exit) ? failureOf(exit.cause).reason : null,
    );
  return {
    desktopSettings: computed(() => value.value ?? UNREAD),
    loaded: computed(() => value.value !== undefined),
    change,
    /** Lets the Flock chat speak first about News that matters, or not. */
    setProactive: (proactive: boolean) => change({ proactive }),
  };
};
