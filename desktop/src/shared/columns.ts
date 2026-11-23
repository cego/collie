// WARNING: no Bun-only import: the view bundles this.
export type Column = "reading" | "wide" | "full";

const COLUMNS = new Map<string, Column>([
  ["flow", "full"],
  ["evidence", "wide"],
  ["log", "wide"],
  ["settings", "wide"],
  ["workflows", "full"],
  ["diff", "full"],
  ["terminal", "full"],
]);

export const columnOf = (tabOrPage: string) => COLUMNS.get(tabOrPage) ?? "reading";
