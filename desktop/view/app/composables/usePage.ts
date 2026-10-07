// The page over the board's column (docs/using.md, Collie Desktop). The board's gestures
// decide which record; this only holds it.

export type Page =
  | { readonly kind: "record"; readonly key: string }
  | { readonly kind: "settings" }
  | { readonly kind: "machines" };

const page = ref<Page | null>(null);
const asked = ref<string | null>(null);

export const usePage = () => ({
  page: readonly(page),
  asked: readonly(asked),
  showRecord: (key: string, tab: string | null = null) => {
    page.value = { kind: "record", key };
    asked.value = tab;
  },
  open: (kind: "settings" | "machines") => (page.value = { kind }),
  /** Opens it, or goes back if it is the page open. */
  toggle: (kind: "settings" | "machines") =>
    (page.value = page.value?.kind === kind ? null : { kind }),
  taken: () => (asked.value = null),
  back: () => (page.value = null),
});
