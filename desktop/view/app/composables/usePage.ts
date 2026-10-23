// The page over the board's column (docs/using.md, Collie Desktop). The board's gestures
// decide which record; this only holds it.

export type Page =
  | { readonly kind: "record"; readonly key: string }
  | { readonly kind: "settings" }
  | { readonly kind: "machines" }
  | { readonly kind: "workflows" }
  | { readonly kind: "usage" };

const page = ref<Page | null>(null);
const asked = ref<string | null>(null);
const runAsked = ref<string | null>(null);

export const usePage = () => ({
  page: readonly(page),
  asked: readonly(asked),
  runAsked: readonly(runAsked),
  runTaken: () => (runAsked.value = null),
  showRecord: (key: string, tab: string | null = null, run: string | null = null) => {
    page.value = { kind: "record", key };
    asked.value = tab;
    runAsked.value = run;
  },
  open: (kind: Exclude<Page["kind"], "record">) => (page.value = { kind }),
  /** Opens it, or goes back if it is the page open. */
  toggle: (kind: Exclude<Page["kind"], "record">) =>
    (page.value = page.value?.kind === kind ? null : { kind }),
  taken: () => (asked.value = null),
  back: () => (page.value = null),
});
