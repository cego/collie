// herdr agent names must match /^[a-z][a-z0-9_-]{0,31}$/, so they cannot be the
// readable labels. Labels go on tabs and panes; these go on agents.

import { DEFAULT_MODEL } from "./harness";
import { parseMrTarget } from "./mr";

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
export function targetLabel(
  workflow: string,
  slug: string,
  inputs: Record<string, string>,
): string {
  const target = inputs.target ?? "";
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

/** Tab order: the Session's board, then these, then anything else in start order. */
export const WORKFLOW_ORDER = ["plan", "implement", "review"] as const;

/** Lower sorts first. An unknown workflow ranks after every known one. */
export function rankOf(workflow: string): number {
  const at = WORKFLOW_ORDER.findIndex((known) => known === workflow);
  return at === -1 ? WORKFLOW_ORDER.length : at;
}

/** One tab of the workspace, as the placement rule sees it. */
export interface RankedTab {
  /** The rank of the Run that owns this tab, or null for a tab Collie does not own. */
  rank: number | null;
  /** The Session's board, which is pinned first. */
  board: boolean;
}

/**
 * Where a new tab of this rank belongs: after the last tab Collie owns whose rank is
 * no greater, and otherwise directly after the board. One insertion, so every tab
 * Collie does not own keeps its place and its order relative to the others — and ties
 * fall after what is already there, which is start order.
 */
export function insertIndexFor(tabs: ReadonlyArray<RankedTab>, rank: number): number {
  let after = -1;
  for (const [at, tab] of tabs.entries()) {
    // The board is read from the list rather than assumed to be index 0: its pin can
    // fail, and the run carries on when it does.
    if (tab.board || (tab.rank !== null && tab.rank <= rank)) after = at;
  }
  return after + 1;
}

/**
 * As much of a Run's record as its tabs' labels are made of. Structural, so `naming`
 * stays the leaf it is: everything here is a string, and the one caller that has a
 * whole `RunRecord` passes it unchanged.
 */
export interface LabelledRun {
  workflow: string;
  slug: string;
  inputs: Record<string, string>;
  /** What the Run recorded itself as pointed at; derived again for an older record. */
  target_label: string | null;
  /** The Task this Run belongs to, whose workspace label already names the work. */
  task: string | null;
  status: "running" | "done" | "blocked" | "failed";
  max_iterations: number;
  steps: ReadonlyArray<{
    id: string;
    status: string;
    /** Which round of the loop this step last ran in; 1 for a step that has not looped. */
    iteration: number;
    variants: ReadonlyArray<{ agent: string; tabId: string | null }>;
  }>;
}

/** What a Run is called wherever a human reads it: the workflow, and what it is for. */
export function runLabel(run: {
  workflow: string;
  slug: string;
  inputs: Record<string, string>;
  target_label: string | null;
}): string {
  return disambiguate(
    displayName(run.workflow),
    run.target_label ?? targetLabel(run.workflow, run.slug, run.inputs),
  );
}

/**
 * The step a Run is on and the round of the loop it is in, or `null` for a Run with no
 * step running. One rule, because two places say it: the tab label and the Control
 * Plane's group row, which must not drift. `round` is `null` until the step has looped —
 * a workflow with no fix loop in it, and every step before one, is named by itself.
 */
export function stepNow(run: LabelledRun): { id: string; round: string | null } | null {
  const step = run.steps.find((s) => s.status === "running" || s.status === "blocked");
  if (!step) return null;
  return {
    id: step.id,
    round: step.iteration > 1 ? `${step.iteration}/${run.max_iterations}` : null,
  };
}

/**
 * `⚙ Implement · control-plane-glass · fix 3/5`: the Run, and the step it is on. This
 * is what herdr's sidebar row for the workspace shows, so it says the two things a
 * human used to open the workspace to learn — which step, and how far into the loop.
 *
 * The step and iteration come off the record alone, so the Driver and the board compute
 * the same string and neither has to know which of a workflow's steps the loop covers.
 * A run that is over is what it was — the step it stopped on is the log's business.
 */
export function runTabLabel(glyph: string, run: LabelledRun, asking: boolean): string {
  const parts = [tabbedName(run)];
  if (run.status === "running") {
    const step = stepNow(run);
    // A question is worth saying instead of the step it is asked from: it is the one
    // state where the run is not going to move until someone reads the row.
    if (asking) parts.push("asks you");
    else if (step) parts.push([step.id, step.round].filter((part) => part !== null).join(" "));
  }
  return `${glyph} ${parts.join(" · ")}`;
}

/**
 * What a tab calls its Run. Inside a task workspace the workspace label already says
 * what the work is, so repeating it costs the width the step needs — the workflow is
 * what the tab adds. One repository of a fan-out keeps its own name: several of them
 * run in one task workspace and are otherwise the same sentence.
 */
function tabbedName(run: LabelledRun): string {
  if (run.task === null) return runLabel(run);
  return disambiguate(displayName(run.workflow), run.inputs.repo ?? "");
}

/**
 * Whether a tab's current label is still one Collie wrote for this Run, and so whether
 * renaming it would overwrite a human's own choice. Collie's labels are a status glyph
 * and this Run's own name; anything else on the tab was typed by somebody, and a tab
 * Collie has no label for at all is one it has just made.
 *
 * Stateless on purpose: the Driver and the board both rename these tabs, and a memo
 * only one of them kept would let the other undo a rename the human had made.
 */
export function collieOwns(current: string | undefined, run: LabelledRun): boolean {
  if (current === undefined || current.trim() === "") return true;
  if (current === tabNameOf(current)) return false;
  return tabNameOf(current).startsWith(tabbedName(run));
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

/**
 * What one tab's glyph means: the state of what is in it. Anything working in there is
 * ⚙ whatever the run last recorded — which is what a review handed back to a live
 * implementer, or a finished agent prompted again, used to leave stuck at ✓. With
 * nothing working and nobody being asked, the run's own state is what is left to say.
 *
 * `statuses` is herdr's live word for each pane of the tab; an agent herdr no longer
 * has contributes none, so it neither claims work nor denies it.
 */
export function tabGlyph(
  statuses: ReadonlyArray<string>,
  run: { status: LabelledRun["status"] },
  asking: boolean,
): string {
  if (statuses.some((status) => status === "working")) return GLYPH.running;
  if (statuses.some((status) => status === "blocked")) return GLYPH.waiting;
  if (asking) return GLYPH.waiting;
  if (run.status === "done") return GLYPH.done;
  if (run.status === "failed") return GLYPH.failed;
  if (run.status === "blocked") return GLYPH.waiting;
  return GLYPH.running;
}

/**
 * Every tab this Run has, and what herdr should be calling it: one label for the Run
 * and a glyph per tab. Pure, and the whole of the reconcile — the Driver hands it what
 * it knows about its own agents and the Control Plane hands it `agent list`, so
 * whichever writes last writes the same thing.
 */
export function tabLabelsFor(
  run: LabelledRun,
  statusOf: (agent: string) => string | undefined,
  asking: boolean,
): Map<string, string> {
  const panes = new Map<string, string[]>();
  for (const step of run.steps) {
    for (const variant of step.variants) {
      if (variant.tabId === null) continue;
      const statuses = panes.get(variant.tabId) ?? [];
      const status = statusOf(variant.agent);
      if (status !== undefined) statuses.push(status);
      panes.set(variant.tabId, statuses);
    }
  }
  return new Map(
    [...panes].map(([tabId, statuses]) => [
      tabId,
      runTabLabel(tabGlyph(statuses, run, asking), run, asking),
    ]),
  );
}
