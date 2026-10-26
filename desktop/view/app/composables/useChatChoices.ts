// The Flock chat's harness, model and effort selects, over Desktop's settings and the chat's
// account, and a choice saved at once.

import type { DesktopSettingsChange } from "../../../src/shared/flock";
import {
  chatSelects,
  choiceNotices,
  rememberChoice,
  refusalSaid,
  type SetChoice,
  stayOn,
} from "../../../src/shared/chat-choices";
import { chatChoicesAtom } from "../flock";

export const useChatChoices = () => {
  const { desktopSettings, loaded, change } = useDesktopSettings();
  const { value } = useHeld(() => chatChoicesAtom);
  const remembered = shallowRef<SetChoice | null>(null);
  watch(
    [desktopSettings, value, loaded],
    ([settings, choices, read]) => {
      if (read) remembered.value = rememberChoice(remembered.value, settings, choices ?? null);
    },
    { immediate: true },
  );
  /** Why the latest choice was refused, until it is dismissed or another is made. */
  const refused = ref<string | null>(null);
  const choose = (changed: DesktopSettingsChange) => {
    refused.value = null;
    return change(changed).then((reason) => {
      if (reason !== null) refused.value = refusalSaid(reason);
    });
  };
  return {
    selects: computed(() => chatSelects(desktopSettings.value, value.value ?? null)),
    notices: computed(() => choiceNotices(desktopSettings.value, value.value ?? null)),
    refused,
    choose,
    stay: () =>
      value.value === undefined ? Promise.resolve() : choose(stayOn(value.value, remembered.value)),
    dismiss: () => {
      refused.value = null;
    },
  };
};
