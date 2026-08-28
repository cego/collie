// herdr agent names must match /^[a-z][a-z0-9_-]{0,31}$/, so they cannot be the
// readable labels. Labels go on tabs and panes; these go on agents.

import { DEFAULT_MODEL } from "./harness";

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

/**
 * The Session's own tab, and the label on the view pane inside it. One per
 * workspace: the runner reuses it, and recreates it when it has been closed.
 */
export const CONTROL_PLANE = "Control Plane";

/**
 * Everything a human reads is Capitalized. A model id that is not a word keeps
 * its own casing (`gpt-5.6-sol`), and a target keeps whatever it actually is —
 * a branch is not a branch any more once it has been prettied up.
 */
export function displayName(name: string): string {
  const [head = "", ...rest] = name.split(" · ");
  const word = /^[a-z][a-z-]*$/.test(head) ? `${head[0]!.toUpperCase()}${head.slice(1)}` : head;
  return [word, ...rest].join(" · ");
}

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

/**
 * `⚙ review`. A tab is the word a human would say for what is in it: the workflow
 * for a run's own tab, the step for a step's. The target is added only where two
 * live tabs would otherwise read the same.
 */
export function tabLabel(glyph: string, name: string): string {
  return `${glyph} ${displayName(name)}`;
}

/** The name part of a tab label, i.e. what a collision is judged on. */
export function tabNameOf(label: string): string {
  const glyphs = Object.values(GLYPH).join("");
  return label.replace(new RegExp(`^[${glyphs}]\\s*`), "").trim();
}

/** `implement` vs `implement · add-picker`, once something else owns the plain name. */
export function disambiguate(name: string, target: string): string {
  return target ? `${name} · ${target}` : name;
}

/** `openai-codex/gpt-5.6-sol` is a model id; `gpt-5.6-sol` is the model. */
function shortModel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

/**
 * A pane says only what the tab cannot. Parallel variants say which model they
 * are; a pane sharing a tab with others says which step it is; a pane alone in
 * its tab says nothing, because the tab already said it.
 */
export function paneLabel(
  variant: { harness: string; model: string },
  stepId: string,
  variantCount: number,
  sharesTab: boolean,
): string | null {
  if (variantCount > 1) {
    // On the harness's own default there is no model to name, so the harness is the name.
    const name = variant.model === DEFAULT_MODEL ? variant.harness : shortModel(variant.model);
    return displayName(name);
  }
  // `use:` prefixes an embedded step's id; the prefix is bookkeeping, not a name.
  return sharesTab ? displayName(stepId.slice(stepId.lastIndexOf(".") + 1)) : null;
}

/** Splitting N panes evenly: the i-th split leaves the left pane 1/N of the tab. */
export function evenRatio(index: number, count: number): number {
  return 1 / (count - index + 1);
}
