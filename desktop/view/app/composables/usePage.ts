// The page over the board's column: a card's record by its key across the Flock, Settings or
// Machines, or none and the board shows. Opening one replaces the one open, and back always
// returns to the board. A record also keeps the tab asked for with it until it takes it, and
// opening one selects its card.

import type { About } from "../../../src/shared/chat-view";

export type Page =
  | { readonly kind: "record"; readonly key: string }
  | { readonly kind: "settings" }
  | { readonly kind: "machines" };

const page = ref<Page | null>(null);
const asked = ref<string | null>(null);

export const usePage = () => {
  const { choose } = useChip();
  return {
    page: readonly(page),
    asked: readonly(asked),
    openRecord: (key: string, about: About, tab: string | null = null) => {
      choose(about);
      page.value = { kind: "record", key };
      asked.value = tab;
    },
    open: (kind: "settings" | "machines") => (page.value = { kind }),
    taken: () => (asked.value = null),
    back: () => (page.value = null),
  };
};
