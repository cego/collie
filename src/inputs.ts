// Input inference: branch, cwd, earlier Runs and the open MR. The human is asked
// only when inference fails (CONTEXT.md, Input).

import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { InputStrategy } from "./definitions";
import { diffTargetOf, recorded, targetKind, type TargetKind } from "./strategies";
import { RunStore } from "./run";
import { targetLabel } from "./naming";
import { ago } from "./time";
import { type Runner, mrTarget, parseMrTarget, projectHere, shell as shellRun } from "./mr";

const JsonId = Schema.Union([Schema.String, Schema.Number]);
const MrViewJson = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.optionalKey(Schema.String),
    iid: Schema.optionalKey(JsonId),
    id: Schema.optionalKey(JsonId),
  }),
);
const MrRowsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      iid: Schema.optionalKey(JsonId),
      id: Schema.optionalKey(JsonId),
      title: Schema.optionalKey(Schema.String),
    }),
  ),
);
/**
 * One thing a human may pick, whoever is drawing the list: a workflow, a candidate for
 * an Input, an option in a Choice. Here rather than with a renderer because both
 * `InputPrompts` and the Run directory's pending Choice are written in it.
 */
export interface PickItem {
  id: string;
  title: string;
  subtitle?: string;
}

/** Where the work to be done was described. */
export type WorkSourceKind = "plan-dir" | "linear" | "text" | "review" | "followup";

export { targetKind, type TargetKind };

export type CandidateKind = WorkSourceKind | TargetKind;

/** One thing the human may pick for an Input, whatever the Input is. */
export interface Candidate {
  kind: CandidateKind;
  value: string;
  source: string;
  label?: string;
  /**
   * Offer it, but never let inference alone land on it. An unrelated merge request
   * of mine is a reasonable thing to pick from a menu and never a reasonable thing
   * to review unasked.
   */
  menuOnly?: boolean;
}

export type WorkSourceCandidate = Candidate;

/** How a work-source reaches the human; the picker and the runner pane both supply it. */
export interface InputPrompts<E = never, R = never> {
  menu(
    items: PickItem[],
    opts: { header: string; footer?: string },
  ): Effect.Effect<PickItem | null, E, R>;
  ask(question: string): Effect.Effect<string | null, E, R>;
}

/** More than this and the oldest plans would bury the branch's own ticket. */
const PLAN_DIR_CANDIDATES = 3;
// Beyond five, the remembered targets bury the branch's own MR, which is the common case.
const REVIEWED_TARGETS = 5;
const WORK_SOURCE_QUESTION = "What should be built?";
const TARGET_QUESTION = "Review what?";
const TYPE_IT = "type";

export interface Resolution {
  name: string;
  strategy: InputStrategy;
  value: string;
  source: string;
  /** True when nothing could be inferred and the human must supply it. */
  needsAsking: boolean;
  question: string;
  /** A short name for this value, when the value itself would name the Run badly. */
  label?: string;
  /** Which sort of thing the value is, for an Input that has kinds. */
  kind?: CandidateKind;
  /** What the human may pick from. */
  candidates?: Candidate[];
  /** The default branch a bare ref is compared against, for a `diff-target`. */
  base?: string;
  /** The GitLab project this directory pushes to, for a bare MR iid. */
  project?: string;
}

export interface InferContext<R = ChildProcessSpawner.ChildProcessSpawner> {
  cwd: string;
  /** The plugin state dir, so earlier Runs can be searched for a plan. */
  stateDir?: string;
  /**
   * The Task this inference is for. Only that Task's own finished Runs are offered:
   * a repository match alone must not hand one Task another's plan or review. Absent
   * — a fresh start — is a Task with nothing behind it yet, so nothing is inferred.
   */
  task?: string | null;
  run?: Runner<R>;
}

/** The one place a subprocess is started for inference; the MR step borrows it too. */
export const shell = shellRun;

export function inferInput(
  name: string,
  strategy: InputStrategy,
  ctx: InferContext,
): Effect.Effect<
  Resolution,
  PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const run = ctx.run ?? shell;
    const base = { name, strategy, needsAsking: false, question: `${name}?` };

    switch (strategy) {
      case "goal":
        return {
          ...base,
          value: "",
          source: "ask",
          needsAsking: true,
          question: "What is the goal?",
        };

      case "plan-dir": {
        const plan = ctx.stateDir
          ? (yield* planDirs(ctx.stateDir, ctx.cwd, 1, ctx.task))[0]
          : undefined;
        if (plan) {
          return { ...base, value: plan.value, source: plan.source, label: plan.label };
        }
        return {
          ...base,
          value: "",
          source: "ask",
          needsAsking: true,
          question: "Path to the plan directory (no finished run has planned this project yet)",
        };
      }

      case "diff-target": {
        const candidates = yield* targetCandidates(ctx);
        // Inference still picks the value; the menu only lets the human override it,
        // and the head of the list is what inference alone would have chosen.
        const baseRef = (yield* defaultBase(run, ctx.cwd)) ?? "";
        const project = (yield* projectHere(ctx.cwd, run)) ?? undefined;
        const common = { ...base, candidates, base: baseRef, project };
        // A directory that is not a checkout offers nothing to infer from, and a
        // list of only menu-only entries is the same answer: ask rather than review
        // whichever unrelated merge request happens to sort first.
        const inferred = candidates.find((c) => !c.menuOnly);
        if (!inferred) {
          return {
            ...common,
            value: "",
            source: "ask",
            needsAsking: true,
            question: TARGET_QUESTION,
          };
        }
        return { ...common, ...inferred };
      }

      case "ticket": {
        const found = yield* ticketFromBranch(run, ctx.cwd);
        return found ? { ...base, ...found } : { ...base, value: "", source: "none" };
      }

      case "work-source": {
        const candidates = yield* workSourceCandidates(ctx);
        // One candidate is an answer; none or several are a question for the human.
        if (candidates.length === 1) return { ...base, ...candidates[0]! };
        return {
          ...base,
          value: "",
          source: "ask",
          needsAsking: true,
          question: WORK_SOURCE_QUESTION,
          candidates,
        };
      }

      case "flag":
        return { ...base, value: "false", source: "default" };

      // Declared so the placeholder resolves, empty until a workflow embedding this
      // one passes a value of its own. Never asked for.
      case "optional":
        return { ...base, value: "", source: "default" };
      case "gitlab-repository":
        return {
          ...base,
          value: "",
          source: "ask",
          needsAsking: true,
          question: "GitLab repository URL or local checkout",
        };
      default:
        return { ...base, value: "", source: "ask", needsAsking: true };
    }
  });
}

function ticketFromBranch(
  run: NonNullable<InferContext["run"]>,
  cwd: string,
): Effect.Effect<
  { value: string; source: string } | null,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const branch = (yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout.trim();
    const m = /([A-Z][A-Z0-9]+-\d+)/.exec(branch);
    return m ? { value: m[1]!, source: `branch ${branch}` } : null;
  });
}

export function inferInputs(
  inputs: Record<string, InputStrategy>,
  ctx: InferContext,
): Effect.Effect<
  Resolution[],
  PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.forEach(Object.entries(inputs), ([name, strategy]) =>
    inferInput(name, strategy, ctx),
  );
}

function mrIid(stdout: string): string | null {
  return Option.match(Schema.decodeUnknownOption(MrViewJson)(stdout), {
    onNone: () => null,
    onSome: (data) => {
      if (data.state !== undefined && !["opened", "open"].includes(data.state.toLowerCase()))
        return null;
      const iid = data.iid ?? data.id;
      return iid === undefined ? null : String(iid);
    },
  });
}

export function defaultBase(
  run: NonNullable<InferContext["run"]>,
  cwd: string,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const head = yield* run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
    if (head.code === 0 && head.stdout.trim()) {
      return head.stdout.trim().replace(/^origin\//, "");
    }
    for (const candidate of ["main", "master"]) {
      const exists = yield* run("git", ["rev-parse", "--verify", "--quiet", candidate], cwd);
      if (exists.code === 0) return candidate;
    }
    return null;
  });
}

/**
 * The newest finished Runs for this repo that wrote a plan, newest first. Any
 * workflow may write one (`plan`, `architecture`), so having `plan/SPEC.md` is the
 * test, not the workflow's name (ADR-0002).
 */
export function planDirs(
  stateDir: string,
  cwd: string,
  limit: number,
  task?: string | null,
): Effect.Effect<WorkSourceCandidate[], PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found: WorkSourceCandidate[] = [];
    for (const run of yield* new RunStore(stateDir).finished(cwd, task)) {
      if (found.length >= limit) break;
      const dir = path.join(run.dir, "plan");
      if (!(yield* fs.exists(path.join(dir, "SPEC.md")))) continue;
      const prefix = `${run.record.workflow}-`;
      const slug = run.record.slug;
      found.push({
        kind: "plan-dir",
        value: dir,
        source: `plan run ${run.id}`,
        label: slug.startsWith(prefix) ? slug.slice(prefix.length) : slug,
      });
    }
    return found;
  });
}

/**
 * Targets this repo's finished Runs have reviewed, newest first, deduplicated.
 * Reviewing is a rally, and the second review should not need the link pasted again.
 */
export function reviewedTargets(
  stateDir: string,
  cwd: string,
  limit: number,
  task?: string | null,
): Effect.Effect<Candidate[], PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const found: Candidate[] = [];
    const seen = new Set<string>();
    for (const run of yield* new RunStore(stateDir).finished(cwd, task)) {
      if (found.length >= limit) break;
      const target = diffTargetOf(recorded(run.record))?.value;
      if (!target) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      // What came of it, from the record alone: the menu must not read N files.
      const open = run.record.outstanding.length;
      const when = ago(run.record.finished_at ?? run.record.created_at, now);
      found.push({
        kind: targetKind(target),
        value: target,
        source: open > 0 ? `reviewed ${when} · ${open} finding(s) open` : `reviewed ${when}`,
        label: run.record.target_label ?? targetLabel(run.record.workflow, run.record.slug, target),
      });
    }
    return found;
  });
}

/** Everything that could describe the work here: the recent plans, then the branch's ticket. */
export function workSourceCandidates(
  ctx: InferContext,
): Effect.Effect<
  WorkSourceCandidate[],
  PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const candidates = ctx.stateDir
      ? yield* planDirs(ctx.stateDir, ctx.cwd, PLAN_DIR_CANDIDATES, ctx.task)
      : [];
    const ticket = yield* ticketFromBranch(ctx.run ?? shell, ctx.cwd);
    if (ticket) candidates.push({ kind: "linear", value: ticket.value, source: ticket.source });
    return candidates;
  });
}

/**
 * Everything this repo could sensibly have a review pointed at, in the order plain
 * inference would have picked them: the branch's own MR (else mine), the branch
 * against its base, then the working tree.
 */
export function targetCandidates(
  ctx: InferContext,
): Effect.Effect<
  Candidate[],
  PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const run = ctx.run ?? shell;
    const out: Candidate[] = [];
    // Whether this directory is a checkout at all decides which candidates exist:
    // a group folder has no branch and no working tree to review.
    const inRepo = (yield* run("git", ["rev-parse", "--git-dir"], ctx.cwd)).code === 0;
    const project = inRepo ? yield* projectHere(ctx.cwd, run) : null;

    const view = yield* run("glab", ["mr", "view", "--output", "json"], ctx.cwd);
    const iid = view.code === 0 ? mrIid(view.stdout) : null;
    if (iid) {
      out.push({
        kind: "mr",
        value: mrTarget(project, iid),
        source: `open merge request !${iid}`,
        label: `!${iid}`,
      });
    } else {
      // This branch has no MR, so offer the ones I would otherwise go looking for.
      for (const mine of yield* myOpenMrs(run, ctx.cwd, project)) out.push(mine);
    }

    if (inRepo) {
      const branch = (yield* run(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        ctx.cwd,
      )).stdout.trim();
      const baseRef = yield* defaultBase(run, ctx.cwd);
      if (branch && baseRef && branch !== baseRef) {
        out.push({
          kind: "branch",
          value: `branch:${baseRef}...${branch}`,
          source: `${branch} vs ${baseRef}`,
          label: branch,
        });
      }

      const dirty = (yield* run("git", ["status", "--porcelain"], ctx.cwd)).stdout.trim() !== "";
      // Last, and always there when nothing else is: the working tree is the one
      // target every checkout has, and inference already fell back to it. Menu-only
      // entries do not count, or inference would have nothing left to land on.
      if (dirty || out.every((c) => c.menuOnly)) {
        out.push({
          kind: "worktree",
          value: "worktree",
          source: "working tree",
          label: "working tree",
        });
      }
    }
    // After inference, so "launch and take the default" is unchanged: what this repo
    // has reviewed before, for the second review of the same thing.
    if (ctx.stateDir) {
      const offered = new Set(out.map((c) => c.value));
      for (const remembered of yield* reviewedTargets(
        ctx.stateDir,
        ctx.cwd,
        REVIEWED_TARGETS,
        ctx.task,
      )) {
        if (!offered.has(remembered.value)) out.push(remembered);
      }
    }
    return out;
  });
}

/** Open MRs I am on either side of, deduplicated by iid. */
function myOpenMrs(
  run: NonNullable<InferContext["run"]>,
  cwd: string,
  project: string | null,
): Effect.Effect<Candidate[], never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const seen = new Map<string, Candidate>();
    for (const who of ["--assignee", "--author"]) {
      const res = yield* run("glab", ["mr", "list", who, "@me", "--output", "json"], cwd);
      if (res.code !== 0) continue;
      const parsedRows = Schema.decodeUnknownOption(MrRowsJson)(res.stdout);
      if (Option.isNone(parsedRows)) continue;
      for (const row of parsedRows.value) {
        const id = row.iid ?? row.id;
        if (id === undefined) continue;
        const key = String(id);
        if (seen.has(key)) continue;
        const title = row.title ?? "";
        seen.set(key, {
          kind: "mr",
          value: mrTarget(project, key),
          source: title ? `open MR !${key} — ${title}` : `open MR !${key}`,
          label: `!${key}`,
          menuOnly: true,
        });
      }
    }
    return [...seen.values()].sort(
      (a, b) => Number(parseMrTarget(a.value)?.iid ?? 0) - Number(parseMrTarget(b.value)?.iid ?? 0),
    );
  });
}

/**
 * What the human typed for a review target: an MR iid or URL, a `base...head`
 * range, the working tree, or a bare ref meaning that ref against the base.
 */
export function classifyTarget(
  typed: string,
  baseRef: string,
  project: string | null = null,
): Candidate | null {
  const text = typed.trim();
  if (text === "") return null;
  const source = "typed";

  // A URL names its own project, which is the whole point of pasting one.
  const url = /^(?:https?:\/\/)?([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(text);
  if (url) {
    return {
      kind: "mr",
      value: mrTarget(`${url[1]}/${url[2]}`, url[3]!),
      source,
      label: `!${url[3]}`,
    };
  }

  // A bare iid means one in the project this directory belongs to.
  const iid = /^!?(\d+)$/.exec(text);
  if (iid) return { kind: "mr", value: mrTarget(project, iid[1]!), source, label: `!${iid[1]}` };

  if (/^worktree$/i.test(text))
    return { kind: "worktree", value: "worktree", source, label: "working tree" };

  if (text.includes("...")) return { kind: "branch", value: `branch:${text}`, source, label: text };

  if (!baseRef) return null;
  return { kind: "branch", value: `branch:${baseRef}...${text}`, source, label: text };
}

/**
 * A `diff-target` given on the command line gets the same normalisation a typed one
 * gets from the menu, so a pasted merge-request URL becomes `mr:<project>!<iid>`
 * rather than falling through to `worktree` on its shape alone.
 */
export function classifyGivenTarget(
  typed: string,
  ctx: InferContext,
): Effect.Effect<Candidate, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    // An already-normalised target — from a chained Run, a resume, or a careful
    // human — is passed through: classifying it again would nest its prefix.
    if (/^(mr:|branch:|worktree$)/.test(typed.trim())) {
      return { kind: targetKind(typed.trim()), value: typed.trim(), source: "typed" };
    }
    const run = ctx.run ?? shell;
    const baseRef = (yield* defaultBase(run, ctx.cwd)) ?? "";
    const project = yield* projectHere(ctx.cwd, run);
    return (
      classifyTarget(typed, baseRef, project) ?? {
        kind: targetKind(typed),
        value: typed,
        source: "typed",
      }
    );
  });
}

/** What the human typed: a plan directory, a Linear issue, or the work in their own words. */
export function classifyWorkSource(
  typed: string,
): Effect.Effect<WorkSourceCandidate, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const text = typed.trim();
    const source = "typed";

    // A finished Run whose outcome needs more work. Named rather than inferred: a
    // follow-up reuses that Run's branch and updates its merge request, and neither of
    // those is something to guess at from a path.
    if (text.startsWith("followup:"))
      return { kind: "followup", value: text, source, label: text.slice("followup:".length) };

    const url = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/.exec(text);
    if (url) return { kind: "linear", source, value: url[1]!.toUpperCase() };

    if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(text))
      return { kind: "linear", value: text.toUpperCase(), source };

    // A review run's own dir: the findings are the spec, and the reviewed target is
    // what the work happens on.
    if (yield* isReviewRun(text))
      return { kind: "review", value: text, source, label: textLabel(path.basename(text)) };

    if (yield* isPlanDir(text))
      return { kind: "plan-dir", value: text, source, label: textLabel(path.basename(text)) };

    return { kind: "text", value: text, source, label: textLabel(text) };
  });
}

/** A run dir that produced a review, which is a thing `implement` can be pointed at. */
function isReviewRun(
  dir: string,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (
      dir !== "" &&
      (yield* fs.exists(path.join(dir, "review.md"))) &&
      (yield* fs.exists(path.join(dir, "run.json")))
    );
  });
}

/** What one Input's menu says, so the two of them share the machinery below. */
interface MenuSpec {
  header: string;
  hint: string;
  question: string;
  classify(
    typed: string,
    r: Resolution,
  ): Effect.Effect<Candidate | null, PlatformError, FileSystem.FileSystem | Path.Path>;
}

const WORK_SOURCE_MENU: MenuSpec = {
  header: WORK_SOURCE_QUESTION,
  hint: "a Linear id or URL, or the work in your own words",
  question: "Linear id or URL, or the work in your own words",
  classify: (typed) => classifyWorkSource(typed),
};

const TARGET_MENU: MenuSpec = {
  header: TARGET_QUESTION,
  hint: "an MR iid or URL, or a base...head range",
  question: "MR iid or URL, or a base...head range",
  classify: (typed, r) => Effect.succeed(classifyTarget(typed, r.base ?? "", r.project ?? null)),
};

/**
 * Settles an Input the human chooses from: its candidates as a menu, plus
 * "Type it…" for anything not listed. False when they backed out.
 */
function resolveFromMenu<E, R>(
  r: Resolution,
  prompts: InputPrompts<E, R>,
  spec: MenuSpec,
): Effect.Effect<boolean, PlatformError | E, FileSystem.FileSystem | Path.Path | R> {
  return Effect.gen(function* () {
    const candidates = r.candidates ?? [];
    const items: PickItem[] = candidates.map((c, i) => ({
      id: String(i),
      title: c.label ?? c.value,
      subtitle: `${c.kind} · ${c.source}`,
    }));
    items.push({ id: TYPE_IT, title: "Type it…", subtitle: spec.hint });

    const chosen = yield* prompts
      .menu(items, {
        header: spec.header,
        footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!chosen) return false;

    if (chosen.id !== TYPE_IT) {
      settle(r, candidates[Number(chosen.id)]!);
      return true;
    }

    const typed = yield* prompts.ask(spec.question).pipe(Effect.catch(() => Effect.succeed(null)));
    if (typed === null || typed.trim() === "") return false;
    const classified = yield* spec.classify(typed, r);
    if (!classified) return false;
    settle(r, classified);
    return true;
  });
}

/** The menu an Input needs, whichever Input it is. */
export function resolveCandidates<E, R>(
  r: Resolution,
  prompts: InputPrompts<E, R>,
): Effect.Effect<boolean, PlatformError | E, FileSystem.FileSystem | Path.Path | R> {
  return resolveFromMenu(r, prompts, r.strategy === "diff-target" ? TARGET_MENU : WORK_SOURCE_MENU);
}

export function settle(
  r: Resolution,
  candidate: Pick<WorkSourceCandidate, "value" | "source"> &
    Partial<Pick<WorkSourceCandidate, "kind" | "label">>,
): void {
  r.value = candidate.value;
  if (candidate.kind !== undefined) r.kind = candidate.kind;
  r.source = candidate.source;
  if (candidate.label !== undefined) r.label = candidate.label;
  r.needsAsking = false;
  delete r.candidates;
}

function isPlanDir(
  dir: string,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const info = yield* fs.stat(dir).pipe(Effect.option);
    return (
      Option.isSome(info) &&
      info.value.type === "Directory" &&
      (yield* fs.exists(path.join(dir, "SPEC.md")))
    );
  });
}

/** A few words, enough to name the Run after work that has no shorter name. */
function textLabel(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  let label = "";
  for (const word of words) {
    const next = label ? `${label}-${word}` : word;
    if (next.length > 24) break;
    label = next;
  }
  return label || "work";
}

/** Inputs as the prompts see them: a work-source also exposes `<name>_kind`. */
/**
 * The strategies whose values carry a kind, and so render a `<name>_kind` companion
 * beside the Input itself. Named here because `inputValues` below is what puts them
 * in a Run's inputs: a checker that renders a workflow ahead of a Run reads this to
 * know which `_kind` placeholders can ever be filled.
 */
export const KINDED_STRATEGIES: ReadonlySet<string> = new Set(["work-source", "diff-target"]);

export function inputValues(resolutions: Resolution[]) {
  const values: Record<string, string> = {};
  for (const r of resolutions) {
    values[r.name] = r.value;
    if (r.kind) values[`${r.name}_kind`] = r.kind;
  }
  return values;
}

/** Only real Inputs have a provenance; a `<name>_kind` is a companion of its own Input. */
export function inputSources(resolutions: Resolution[]) {
  const sources: Record<string, string> = {};
  for (const r of resolutions) sources[r.name] = r.source;
  return sources;
}

/** Which strategy settled each Input, which is how everything downstream finds one. */
export function inputStrategies(resolutions: Resolution[]) {
  const strategies: Record<string, string> = {};
  for (const r of resolutions) strategies[r.name] = r.strategy;
  return strategies;
}

/** True for the `<name>_kind` companion `inputValues` adds next to a kinded Input. */
export function isKindCompanion(name: string, inputs: Record<string, string>): boolean {
  return name.endsWith("_kind") && name.slice(0, -"_kind".length) in inputs;
}

export function confirmLine(
  workflow: string,
  resolutions: Resolution[],
  /** The branch a mutating Run was given, and where it came from. */
  branch?: { name: string | null; source: string | null } | null,
): string {
  const parts = resolutions
    .filter((r) => r.value !== "" || r.strategy !== "ticket")
    .map((r) => {
      // A target's value already says its kind (`mr:42`), so only name it when it adds something.
      const where = r.kind && !r.value.startsWith(r.kind) ? `${r.kind} · ${r.source}` : r.source;
      return `${r.name}=${abbreviate(r.value) || "(empty)"} [${where}]`;
    });
  if (branch?.name) parts.push(`branch=${branch.name} [${branch.source ?? "resolved"}]`);
  return `${workflow}: ${parts.join("  ")}`;
}

/** Free text is a whole sentence; the confirm line only has room for the start of it. */
function abbreviate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}
