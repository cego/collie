// WARNING: no Bun-only import: the view bundles this.
export interface BoardState {
  readonly selected: string | null;
  readonly page: string | null;
}

export type Landed =
  | { readonly on: "card"; readonly card: string; readonly asOf: boolean }
  | { readonly on: "control" }
  | { readonly on: "background" };

export type Gesture =
  | { readonly kind: "click"; readonly landed: Landed }
  | { readonly kind: "double-click"; readonly landed: Landed }
  | { readonly kind: "name"; readonly card: string }
  | { readonly kind: "close" }
  | { readonly kind: "escape"; readonly overlay: boolean; readonly typing: boolean };

export const afterGesture = (state: BoardState, gesture: Gesture) => {
  switch (gesture.kind) {
    case "click":
    case "double-click": {
      const { landed } = gesture;
      if (landed.on === "control") return state;
      if (landed.on === "background")
        return state.page === null ? { ...state, selected: null } : state;
      const opens = gesture.kind === "double-click" && !landed.asOf;
      return { selected: landed.card, page: opens ? landed.card : state.page };
    }
    case "name":
      return { selected: gesture.card, page: gesture.card };
    case "close":
      return { ...state, page: null };
    case "escape":
      if (gesture.overlay || gesture.typing) return state;
      return state.page === null ? { ...state, selected: null } : { ...state, page: null };
  }
};

export interface SeenCard {
  readonly installation: string;
  readonly task: { readonly run: string; readonly unseen?: boolean };
}

export const seenBy = (card: SeenCard | undefined) =>
  card?.task.unseen === true
    ? [{ installation: card.installation, action: { _tag: "Seen", runId: card.task.run } as const }]
    : [];

export const seenOnOpening = (
  before: BoardState,
  after: BoardState,
  cardOf: (key: string) => SeenCard | undefined,
) => (after.page === null || after.page === before.page ? [] : seenBy(cardOf(after.page)));

interface Found {
  readonly getAttribute: (name: string) => string | null;
  readonly hasAttribute: (name: string) => boolean;
}

export type Target = {
  readonly closest: (selectors: string) => Found | null;
  readonly isContentEditable?: boolean;
} | null;

interface Page {
  readonly querySelector: (selectors: string) => object | null;
}

const CONTROL = "button, a, input, label, form, summary";
const FIELD = "input, textarea, select";
const OVERLAY =
  '[data-state="open"]:is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])';

export const landedOn = (target: Target) => {
  if (target === null) return { on: "background" };
  if (target.closest(CONTROL) !== null) return { on: "control" };
  const card = target.closest("[data-card]");
  return card === null
    ? { on: "background" }
    : {
        on: "card",
        card: card.getAttribute("data-card") ?? "",
        asOf: card.hasAttribute("data-as-of"),
      };
};

export const overlayOpen = (page: Page) => page.querySelector(OVERLAY) !== null;

export const inField = (target: Target) =>
  target !== null && (target.isContentEditable === true || target.closest(FIELD) !== null);

export const escapeOn = (target: Target, page: Page) => ({
  kind: "escape",
  overlay: overlayOpen(page) || (target?.closest("[data-escape-scope]") ?? null) !== null,
  typing: inField(target),
});
