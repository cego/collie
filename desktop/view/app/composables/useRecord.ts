// Which card's record is open, by its key across the Flock, and the tab asked for with it
// until the record takes it. Opening one selects its card.

import type { About } from "../../../src/shared/chat-view";

const opened = ref<string | null>(null);
const asked = ref<string | null>(null);

export const useRecord = () => {
  const { choose } = useChip();
  return {
    opened,
    asked: readonly(asked),
    open: (key: string, about: About, tab: string | null = null) => {
      choose(about);
      opened.value = key;
      asked.value = tab;
    },
    taken: () => (asked.value = null),
    close: () => (opened.value = null),
  };
};
