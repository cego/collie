// What a click, a double-click and Escape on the board do to the selected card. No Bun-only
// import: the view bundles this.

/** Where a click or a key landed: an element, or nothing that is one. */
export type Target = {
  readonly closest: (selectors: string) => object | null;
  readonly isContentEditable?: boolean;
} | null;

export const targetOf = (event: Event): Target =>
  event.target instanceof Element ? event.target : null;

interface Page {
  readonly querySelector: (selectors: string) => object | null;
}

const CONTROL = "button, a, input, label, form, summary";
const FIELD = "input, textarea, select";
const OVERLAY =
  '[data-state="open"]:is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])';

/** A control does only what it does; a card's body selects it; the rest is the board's own. */
export const placeOf = (target: Target): "control" | "card" | "board" => {
  if (target === null) return "board";
  if (target.closest(CONTROL) !== null) return "control";
  return target.closest("[data-card]") !== null ? "card" : "board";
};

/** A card whose Machine dropped can be selected, but its record has nobody to read it from. */
export const opensOnDoubleClick = (target: Target, asOf: number | null) =>
  placeOf(target) === "card" && asOf === null;

/** Escape belongs to a field typed in and to an open overlay, which closes itself on it. */
export const escapeLetsGo = (target: Target, page: Page) =>
  !(target !== null && (target.isContentEditable === true || target.closest(FIELD) !== null)) &&
  page.querySelector(OVERLAY) === null;
