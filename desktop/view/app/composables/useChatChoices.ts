// The Flock chat's harness, model and effort selects, over Desktop's settings and the account
// the main process pushes of what the chat holds and could run on.

import {
  type ChatSet,
  chatNotice,
  chatSelects,
  chosen,
  heldChoice,
  refusedChoice,
  stayChange,
} from "../../../src/shared/chat-choices";
import type { DesktopSettingsChange } from "../../../src/shared/flock";
import { chatChoicesAtom } from "../flock";

export type ChatChoice = "harness" | "model" | "effort";

export const useChatChoices = () => {
  const { value } = useHeld(() => chatChoicesAtom);
  const { desktopSettings, change } = useDesktopSettings();
  const refused = ref<string | null>(null);
  // This window's own: what Stay puts back.
  const held = ref<ChatSet | null>(null);
  watch(
    [desktopSettings, value],
    ([settings, choices]) => {
      if (choices !== undefined) held.value = heldChoice(held.value, settings, choices.heldOn);
    },
    { immediate: true },
  );
  /** Saves `settings` at once; a refusal saves nothing. */
  const save = (settings: DesktopSettingsChange) =>
    change(settings).then((reason) => {
      refused.value = reason === null ? null : refusedChoice(reason);
    });
  return {
    /** Null until the account is first told. */
    selects: computed(() =>
      value.value === undefined ? null : chatSelects(desktopSettings.value, value.value),
    ),
    notice: computed(() =>
      value.value === undefined ? null : chatNotice(desktopSettings.value, value.value),
    ),
    /** What the last choice was refused for, until it is dismissed or a choice is saved. */
    refused,
    dismiss: () => {
      refused.value = null;
    },
    choose: (which: ChatChoice, value: string) => save(chosen(which, value)),
    /** Puts back the choice the held conversation was on. */
    stay: () =>
      value.value === undefined
        ? Promise.resolve()
        : save(stayChange(held.value, value.value.heldOn)),
  };
};
