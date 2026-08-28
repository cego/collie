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

/** ⚙ working, ⚠ your turn, ✓ finished, ✗ stopped. */
export const GLYPH = { running: "⚙", waiting: "⚠", done: "✓", failed: "✗" } as const;

export const STATUS_PANE = "status";

/** A sha, or `HEAD`, names nothing a human recognises on a tab. */
function opaque(ref: string): boolean {
  return ref === "" || ref === "HEAD" || /^[0-9a-f]{7,40}$/i.test(ref);
}

/**
 * What this run is pointed at, short enough for a tab: an MR as `!123`, a branch
 * by name, the working tree, or — for the workflows that have no target — the
 * run's own slug without the workflow it already carries.
 */
export function targetLabel(workflow: string, slug: string, inputs: Record<string, string>): string {
  const target = inputs.target ?? "";
  if (target === "worktree") return "worktree";
  if (target.startsWith("mr:")) return `!${target.slice(3)}`;
  if (target.startsWith("branch:")) {
    const [base = "", head = ""] = target.slice(7).split("...");
    if (!opaque(head)) return head;
    if (!opaque(base)) return base;
    return "diff";
  }
  const prefix = `${workflow}-`;
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
}

/** `⚙ review · !123`. The step is on the panes, not here. */
export function tabLabel(glyph: string, workflow: string, target: string): string {
  return target ? `${glyph} ${workflow} · ${target}` : `${glyph} ${workflow}`;
}

/**
 * A pane says which agent it is: the model alone where the harness is the one
 * everything else uses, `codex gpt-5` where it is not. A step running on its own
 * has nothing to distinguish, so it takes the step's name.
 */
export function variantLabel(
  variant: { harness: string; model: string },
  defaultHarness: string,
  stepId: string,
  variantCount: number,
): string {
  if (variantCount < 2) return stepId;
  return variant.harness === defaultHarness ? variant.model : `${variant.harness} ${variant.model}`;
}

/** Splitting N panes evenly: the i-th split leaves the left pane 1/N of the tab. */
export function evenRatio(index: number, count: number): number {
  return 1 / (count - index + 1);
}
