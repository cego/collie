// What a click, a double-click, a name, a close and Escape on the board do to the selected card
// and the open record. No Bun-only import: the view bundles this.

/** What is selected and whose record is open, each by card key. */
export interface BoardState {
  readonly selected: string | null;
  readonly record: string | null;
}

/** Where a click or double-click landed. */
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

export const afterGesture = (state: BoardState, gesture: Gesture): BoardState => {
  switch (gesture.kind) {
    case "click":
    case "double-click": {
      const { landed } = gesture;
      if (landed.on === "control") return state;
      if (landed.on === "background")
        return state.record === null ? { ...state, selected: null } : state;
      // A card whose Machine dropped has nobody to read its record from.
      const opens = gesture.kind === "double-click" && !landed.asOf;
      return { selected: landed.card, record: opens ? landed.card : state.record };
    }
    case "name":
      return { selected: gesture.card, record: gesture.card };
    case "close":
      return { ...state, record: null };
    case "escape":
      if (gesture.overlay || gesture.typing) return state;
      return state.record === null ? { ...state, selected: null } : { ...state, record: null };
  }
};

interface Found {
  readonly getAttribute: (name: string) => string | null;
  readonly hasAttribute: (name: string) => boolean;
}

/** Where a click or a key landed: an element, or nothing that is one. */
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

/** A control does only what it does; a card's body is the card's; the rest is the board's own. */
export const landedOn = (target: Target): Landed => {
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

/** Escape as the board reads it: whether an overlay is open, and whether focus is in a field. */
export const escapeOn = (target: Target, page: Page): Gesture => ({
  kind: "escape",
  overlay: page.querySelector(OVERLAY) !== null,
  typing: target !== null && (target.isContentEditable === true || target.closest(FIELD) !== null),
});
