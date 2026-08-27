// herdr agent names must match /^[a-z][a-z0-9_-]{0,31}$/, so they cannot be the
// readable labels. Labels go on tabs and panes; these go on agents.

const MAX = 32;

function sanitize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Unique, valid agent name; the step and variant survive truncation. */
export function agentName(
  slug: string,
  stepId: string,
  variantKey: string | null,
  seq: number,
): string {
  const tail = sanitize([stepId, variantKey, `r${seq}`].filter((p) => p).join("-")).slice(0, MAX);
  const room = MAX - tail.length - 1;
  const head = room > 0 ? sanitize(slug).slice(0, room).replace(/-+$/g, "") : "";
  const name = head ? `${head}-${tail}` : tail;
  return (/^[a-z]/.test(name) ? name : `w${name}`).slice(0, MAX);
}

/** The readable name for a tab or pane. */
export function stepLabel(slug: string, stepId: string, variantKey: string | null): string {
  return [slug, stepId, variantKey].filter((p) => p).join("/");
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
