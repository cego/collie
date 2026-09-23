// herdr agent names must match /^[a-z][a-z0-9_-]{0,31}$/, so they cannot be the
// readable labels. Labels go on tabs and panes; these go on agents.

import { DEFAULT_MODEL } from "./harness";
import { parseMrTarget } from "./mr";
import { diffTargetOf, type Settled } from "./strategies";

const MAX = 32;

function sanitize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Unique, valid agent name. The run's sequence number is what makes it unique
 * across runs, so it is reserved before anything else: a provider-qualified model
 * (`openai-codex/gpt-5.6-sol`) is long enough to have truncated it away, and two
 * runs then picked the same name and herdr refused the second with
 * `agent_name_taken`. The step and the variant take what is left, and the run's
 * slug only what is left after that.
 */
export function agentName(
  slug: string,
  stepId: string,
  variantKey: string | null,
  seq: number,
): string {
  const suffix = `r${seq}`;
  const trim = (text: string, room: number) => text.slice(0, Math.max(0, room)).replace(/-+$/g, "");
  const core = trim(
    sanitize([stepId, variantKey].filter((p) => p).join("-")),
    MAX - suffix.length - 1,
  );
  const tail = core ? `${core}-${suffix}` : suffix;
  const room = MAX - tail.length - 1;
  const head = room > 0 ? trim(sanitize(slug), room) : "";
  const name = head ? `${head}-${tail}` : tail;
  return (/^[a-z]/.test(name) ? name : `w${name}`).slice(0, MAX);
}

/** The readable name for a tab or pane. */
export function stepLabel(slug: string, stepId: string, variantKey: string | null): string {
  return [slug, stepId, variantKey].filter((p) => p).join("/");
}

/**
 * Workflow-controlled names become single path components inside the Run, so a
 * definition must not be able to spell one that lands anywhere else. Returns why
 * a value is unsafe, or null when it is a plain component. Validation wraps it
 * in field-naming messages; Run path construction wraps it in a throw.
 */
export function unsafePathComponent(value: string): string | null {
  if (value === "") return "is empty";
  if (value === "." || value === "..") return `is "${value}"`;
  if (value.includes("/") || value.includes("\\")) return "contains a path separator";
  // Filesystem APIs reject NUL in paths, and a newline corrupts the frontmatter a
  // forked name is written into; catching both here keeps the error a field-naming
  // validation message instead of a raw fs throw or a mangled file after the Run starts.
  if (/\p{Cc}/u.test(value)) return "contains a control character";
  return null;
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** ⚙ working, ⚠ your turn, ✓ finished, ✗ stopped. */
/**
 * What a failure says in a log line or a board row: a caught Error's own message, and
 * anything else as it prints. Both adapters and the engine report failures this way.
 */
export function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const GLYPH = { running: "⚙", waiting: "⚠", done: "✓", failed: "✗" } as const;

/**
 * The dog that marks Collie's own tab. Kept out of GLYPH — that is run status —
 * and out of every call site: the label below is an identity, matched against
 * herdr's own tab list, not a decoration to be assembled where it is used.
 */
const COLLIE_GLYPH = "\u{1F415}";

/**
 * The Session's own tab, and the label on the view pane inside it. One per
 * workspace: the runner reuses it, and recreates it when it has been closed.
 */
export const COLLIE_TAB = `${COLLIE_GLYPH} Collie`;

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

/** A Run's own name, without the workflow its slug already carries. */
export function runName(workflow: string, slug: string): string {
  const prefix = `${workflow}-`;
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
}

/**
 * What this run is pointed at, short enough for a tab: an MR as `!123`, a branch
 * by name, the working tree, or — for the workflows that have no target — the
 * run's own slug without the workflow it already carries.
 */
export function targetLabel(workflow: string, slug: string, target: string): string {
  if (target === "worktree") return "worktree";
  // An MR target carries its project; only the iid belongs on a label.
  const mr = parseMrTarget(target);
  if (mr) return `!${mr.iid}`;
  if (target.startsWith("branch:")) {
    const [base = "", head = ""] = target.slice(7).split("...");
    if (!opaque(head)) return head;
    if (!opaque(base)) return base;
    return "diff";
  }
  return runName(workflow, slug);
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
  const glyphs = [...Object.values(GLYPH), COLLIE_GLYPH].join("");
  // The u flag, or the dog (U+1F415) enters the class as its two surrogate halves
  // and stripping matches one of them, leaving a lone surrogate in the name.
  return label.replace(new RegExp(`^[${glyphs}]\\s*`, "u"), "").trim();
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

/** A Run's title from its facts: the workflow, and what it was pointed at. */
export function runTitle(run: { readonly workflow: string; readonly settled: Settled }): string {
  const target = diffTargetOf(run.settled)?.value ?? "";
  return disambiguate(displayName(run.workflow), targetLabel(run.workflow, "", target));
}

/** `Collie | Task workspaces`: a task workspace's own label, from its two halves. */
export function taskWorkspaceLabel(name: { project: string; title: string }): string {
  return [name.project, name.title]
    .map(oneLine)
    .filter((part) => part !== "")
    .join(" | ");
}

/**
 * A label as herdr may be given it: one line, no control characters, no runs of space.
 * Names reach here from the model and from the user's own live labels, and both are
 * display data — a newline in one would break the sidebar row it is drawn in.
 */
export function oneLine(text: string): string {
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
