// The page over the board's column (docs/using.md, Collie Desktop).

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
    /** Opens it, or goes back if it is the page open. */
    toggle: (kind: "settings" | "machines") =>
      (page.value = page.value?.kind === kind ? null : { kind }),
    taken: () => (asked.value = null),
    back: () => (page.value = null),
  };
};
