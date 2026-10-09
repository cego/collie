// How wide a page or a record's tab is laid out: prose at a reading length, logs and
// evidence wider, a diff or a pane edge to edge.
// No Bun-only import: the view bundles this.

export type Column = "reading" | "wide" | "full";

const COLUMNS = new Map<string, Column>([
  ["evidence", "wide"],
  ["log", "wide"],
  ["diff", "full"],
  ["terminal", "full"],
]);

/** A record's tab, or a page, by the column it is laid out in; anything else reads. */
export const columnOf = (tabOrPage: string): Column => COLUMNS.get(tabOrPage) ?? "reading";
