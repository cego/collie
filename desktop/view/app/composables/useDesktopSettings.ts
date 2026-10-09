// What the human set in Desktop, one copy for the chat's bell and Settings alike.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { DesktopSettings, DesktopSettingsChange } from "../../../src/shared/flock";
import { FlockClient } from "../flock";

const settingsAtom = FlockClient.mutation("settings");
const setSettingsAtom = FlockClient.mutation("setSettings");

const settings = ref<DesktopSettings>({ proactive: true });
let read = false;

export const useDesktopSettings = () => {
  const readSettings = useAtomSet(() => settingsAtom, { mode: "promiseExit" });
  const writeSettings = useAtomSet(() => setSettingsAtom, { mode: "promiseExit" });
  const reread = () =>
    readSettings({ payload: undefined }).then((exit) => {
      if (Exit.isSuccess(exit)) settings.value = exit.value;
    });
  if (!read) {
    read = true;
    void reread();
  }
  /** Whether the change was kept. */
  const change = (changed: DesktopSettingsChange) =>
    writeSettings({ payload: changed }).then((exit) => {
      if (Exit.isSuccess(exit)) settings.value = { ...settings.value, ...changed };
      return Exit.isSuccess(exit);
    });
  return {
    desktopSettings: readonly(settings),
    /** Read again, as the Flock chat may have changed the Machine rule. */
    reread,
    change,
    /** Lets the Flock chat speak first about News that matters, or not. */
    setProactive: (proactive: boolean) => change({ proactive }),
  };
};
