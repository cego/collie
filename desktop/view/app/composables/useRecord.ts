// Which card's record is open, by its key across the Flock. Opening one selects its card.

import type { About } from "../../../src/shared/chat-view";

const opened = ref<string | null>(null);

export const useRecord = () => {
  const { choose } = useChip();
  return {
    opened,
    open: (key: string, about: About) => {
      choose(about);
      opened.value = key;
    },
    close: () => (opened.value = null),
  };
};
