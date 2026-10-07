// What the human set in Desktop, one copy for the chat's bell and Settings alike.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { DesktopSettings } from "../../../src/shared/flock";
import { FlockClient } from "../flock";

const settingsAtom = FlockClient.mutation("settings");
const setSettingsAtom = FlockClient.mutation("setSettings");

const settings = ref<DesktopSettings>({ proactive: true });
let read = false;

export const useDesktopSettings = () => {
  const readSettings = useAtomSet(() => settingsAtom, { mode: "promiseExit" });
  const writeSettings = useAtomSet(() => setSettingsAtom, { mode: "promiseExit" });
  if (!read) {
    read = true;
    void readSettings({ payload: undefined }).then((exit) => {
      if (Exit.isSuccess(exit)) settings.value = exit.value;
    });
  }
  return {
    desktopSettings: readonly(settings),
    /** Lets the Flock chat speak first about News that matters, or not. */
    setProactive: (proactive: boolean) =>
      writeSettings({ payload: { proactive } }).then((exit) => {
        if (Exit.isSuccess(exit)) settings.value = { ...settings.value, proactive };
        return Exit.isSuccess(exit);
      }),
  };
};
