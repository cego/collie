// What the human set in Desktop for this computer alone, as the main process tells every
// window.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { DesktopSettings, DesktopSettingsChange } from "../../../src/shared/flock";
import { desktopSettingsAtom, FlockClient } from "../flock";
import { failureOf } from "./useActions";

const setSettingsAtom = FlockClient.mutation("setSettings");

const UNREAD: DesktopSettings = {};

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
  };
};
