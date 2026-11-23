import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { pipe } from "effect/Function";
import { Clock, Effect, FileSystem, Option, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { ChildProcessSpawner } from "effect/process";
import type { InputStrategy } from "./definitions";
import { diffTargetOf, strategyNamed, targetKind, type TargetKind } from "./strategies";
import type { RunFacts } from "./runs";
import { openFindingsIn } from "./output";
import { targetLabel } from "./naming";
import { FINDINGS_FILE, REVIEW_FILE } from "./output";
import { ago } from "./time";
import { type Runner, forgeHere, projectHere, shell as shellRun } from "./mr";
import type { Forge } from "./forge/forge";
import type { ForgeHttp } from "./forge/http";
import { mrRefsIn, mrWords, readMrRef } from "./board-model";

export interface PickItem {
  id: string;
  title: string;
  subtitle?: string;
}

export type WorkSourceKind = "plan-dir" | "linear" | "text" | "review" | "followup";

export { targetKind, type TargetKind };

export type CandidateKind = WorkSourceKind | TargetKind;

export interface Candidate {
  kind: CandidateKind;
  value: string;
  source: string;
  label?: string;
  // WARNING: Offered in a menu, never chosen by inference alone.
  menuOnly?: boolean;
}

export type WorkSourceCandidate = Candidate;

export interface InputPrompts<E = never, R = never> {
  menu(
    items: PickItem[],
    opts: { header: string; footer?: string },
  ): Effect.Effect<PickItem | null, E, R>;
  ask(question: string): Effect.Effect<string | null, E, R>;
}

// WARNING: More would bury the branch's own ticket behind the oldest plans.
const PLAN_DIR_CANDIDATES = 3;
// WARNING: Beyond five, remembered targets bury the branch's own merge request, the common case.
const REVIEWED_TARGETS = 5;
const WORK_SOURCE_QUESTION = "What should be built?";
const TARGET_QUESTION = "Review what?";
const TYPE_IT = "type";

export interface Resolution {
  name: string;
  strategy: InputStrategy;
  value: string;
  source: string;
  needsAsking: boolean;
  question: string;
  label?: string;
  kind?: CandidateKind;
  candidates?: Candidate[];
  base?: string;
  project?: string;
}

export interface InferContext<R = ChildProcessSpawner.ChildProcessSpawner> {
  cwd: string;
  runs?: ReadonlyArray<RunFacts>;
  // WARNING: Only this Task's finished Runs are offered: a repository match alone must not hand over another Task's plan.
  task?: string | null;
  run?: Runner<R>;
  gitlabHost?: string | undefined;
}

export const shell = shellRun;

export function inferInput(name: string, strategy: InputStrategy, ctx: InferContext) {
  const returned: Effect.Effect<
    Resolution,
    PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | ForgeHttp
  > = Effect.gen(function* () {
    const run = ctx.run ?? shell;
    const base = { name, strategy, needsAsking: false, question: `${name}?` };

    switch (strategyNamed(strategy)) {
      case "goal":
        return {
          ...base,
          value: "",
          source: "ask",
          needsAsking: true,
          question: "What is the goal?",
        };

      case "plan-dir": {
        const plan = ctx.runs ? (yield* planDirs(ctx.runs, ctx.cwd, 1, ctx.task))[0] : undefined;
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
        const baseRef = (yield* defaultBase(run, ctx.cwd)) ?? "";
        const project = (yield* projectHere(ctx.cwd, run)) ?? undefined;
        const common = { ...base, candidates, base: baseRef, project };
        const inferred = Option.getOrUndefined(Arr.findFirst(candidates, (c) => !c.menuOnly));
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

      case "work-source": {
        const candidates = yield* workSourceCandidates(ctx);
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

      case "optional":
      case "reach":
      case "internal":
        return { ...base, value: "", source: "default" };
      case "repository":
        return {
          ...base,
          value: "",
          source: "ask",
          needsAsking: true,
          question: "GitLab or GitHub repository URL, or a local checkout",
        };
      default:
        return { ...base, value: "", source: "ask", needsAsking: true };
    }
  });
  return returned;
}

function ticketFromBranch(run: NonNullable<InferContext["run"]>, cwd: string) {
  const returned: Effect.Effect<
    { value: string; source: string } | null,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > = Effect.gen(function* () {
    const branch = Str.trim((yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout);
    const m = /([A-Z][A-Z0-9]+-\d+)/.exec(branch);
    return m ? { value: m[1]!, source: `branch ${branch}` } : null;
  });
  return returned;
}

export function inferInputs(inputs: Record<string, InputStrategy>, ctx: InferContext) {
  const returned: Effect.Effect<
    Resolution[],
    PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | ForgeHttp
  > = Effect.forEach(Rec.toEntries(inputs), ([name, strategy]) => inferInput(name, strategy, ctx));
  return returned;
}

export function defaultBase(run: NonNullable<InferContext["run"]>, cwd: string) {
  const returned: Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =
    Effect.gen(function* () {
      const head = yield* run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
      if (head.code === 0 && Str.trim(head.stdout)) {
        return pipe(Str.trim(head.stdout), Str.replace(/^origin\//, ""));
      }
      for (const candidate of ["main", "master"]) {
        const exists = yield* run("git", ["rev-parse", "--verify", "--quiet", candidate], cwd);
        if (exists.code === 0) return candidate;
      }
      return null;
    });
  return returned;
}

// WARNING: A fresh start sees Runs recorded before Tasks existed, so an upgraded install's plans stay findable.
function finishedHere(runs: ReadonlyArray<RunFacts>, cwd: string, task?: string | null) {
  return Arr.filter(
    runs,
    (run) => run.project === cwd && run.state === "succeeded" && run.task === (task ?? null),
  );
}

// WARNING: The test is plan/SPEC.md, not the workflow's name.
export function planDirs(
  runs: ReadonlyArray<RunFacts>,
  cwd: string,
  limit: number,
  task?: string | null,
) {
  const returned: Effect.Effect<
    WorkSourceCandidate[],
    PlatformError,
    FileSystem.FileSystem | Path.Path
  > = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found: WorkSourceCandidate[] = [];
    for (const run of finishedHere(runs, cwd, task)) {
      if (found.length >= limit) break;
      const dir = path.join(run.dir, "plan");
      if (!(yield* fs.exists(path.join(dir, "SPEC.md")))) continue;
      found.push({
        kind: "plan-dir",
        value: dir,
        source: `plan run ${run.id}`,
        label: run.task ?? run.id,
      });
    }
    return found;
  });
  return returned;
}

export function reviewedTargets(
  runs: ReadonlyArray<RunFacts>,
  cwd: string,
  limit: number,
  task?: string | null,
) {
  const returned: Effect.Effect<Candidate[], PlatformError, FileSystem.FileSystem | Path.Path> =
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const found: Candidate[] = [];
      const seen = new Set<string>();
      for (const run of finishedHere(runs, cwd, task)) {
        if (found.length >= limit) break;
        const target = diffTargetOf(run.settled)?.value;
        const kind = targetKind(target ?? "");
        if (!target || kind === "") continue;
        if (seen.has(target)) continue;
        seen.add(target);
        const open = yield* openFindingsIn(run.dir);
        const when = ago(run.finished ?? run.created, now);
        found.push({
          kind,
          value: target,
          source: open > 0 ? `reviewed ${when} · ${open} finding(s) open` : `reviewed ${when}`,
          label: targetLabel(run.workflow, run.task ?? run.id, target),
        });
      }
      return found;
    });
  return returned;
}

export function workSourceCandidates(ctx: InferContext) {
  const returned: Effect.Effect<
    WorkSourceCandidate[],
    PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > = Effect.gen(function* () {
    const candidates = ctx.runs
      ? yield* planDirs(ctx.runs, ctx.cwd, PLAN_DIR_CANDIDATES, ctx.task)
      : [];
    const ticket = yield* ticketFromBranch(ctx.run ?? shell, ctx.cwd);
    if (ticket) candidates.push({ kind: "linear", value: ticket.value, source: ticket.source });
    return candidates;
  });
  return returned;
}

export function targetCandidates(ctx: InferContext) {
  const returned: Effect.Effect<
    Candidate[],
    PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | ForgeHttp
  > = Effect.gen(function* () {
    const run = ctx.run ?? shell;
    const out: Candidate[] = [];
    const inRepo = (yield* run("git", ["rev-parse", "--git-dir"], ctx.cwd)).code === 0;
    const project = inRepo ? yield* projectHere(ctx.cwd, run) : null;

    const branch = inRepo
      ? Str.trim((yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], ctx.cwd)).stdout)
      : "";
    const here = inRepo ? yield* forgeHere(ctx.cwd, run, ctx.gitlabHost) : null;
    const forge = here?.ok === true ? here.forge : null;
    const found =
      forge !== null && project !== null && branch !== ""
        ? yield* forge.forBranch(project, branch, ctx.cwd, run)
        : null;
    const open = found?.ok === true ? found.open : null;
    if (forge !== null && open !== null) {
      const words = mrWords({ project, iid: open.iid });
      out.push({
        kind: "mr",
        value: words.target,
        source: `branch ${branch}'s open ${forge.noun} ${words.sign}${open.iid}`,
        label: `${words.sign}${open.iid}`,
      });
    } else if (forge !== null) {
      for (const mine of yield* myOpenMrs(forge, run, ctx.cwd, project)) out.push(mine);
    }

    if (inRepo) {
      const baseRef = yield* defaultBase(run, ctx.cwd);
      if (branch && baseRef && branch !== baseRef) {
        out.push({
          kind: "branch",
          value: `branch:${baseRef}...${branch}`,
          source: `${branch} vs ${baseRef}`,
          label: branch,
        });
      }

      const dirty = Str.trim((yield* run("git", ["status", "--porcelain"], ctx.cwd)).stdout) !== "";
      if (dirty || Arr.every(out, (c) => Boolean(c.menuOnly))) {
        out.push({
          kind: "worktree",
          value: "worktree",
          source: "working tree",
          label: "working tree",
        });
      }
    }
    if (ctx.runs) {
      const offered = new Set(Arr.map(out, (c) => c.value));
      for (const remembered of yield* reviewedTargets(
        ctx.runs,
        ctx.cwd,
        REVIEWED_TARGETS,
        ctx.task,
      )) {
        if (!offered.has(remembered.value)) out.push(remembered);
      }
    }
    return out;
  });
  return returned;
}

function myOpenMrs(
  forge: Forge,
  run: NonNullable<InferContext["run"]>,
  cwd: string,
  project: string | null,
) {
  const answer: Effect.Effect<
    Candidate[],
    never,
    ChildProcessSpawner.ChildProcessSpawner | ForgeHttp
  > = Effect.map(forge.mine(project, cwd, run), (mine) =>
    Arr.map(
      [...mine].sort((a, b) => Number(a.iid) - Number(b.iid)),
      ({ iid, title }) => {
        const words = mrWords({ project, iid });
        const short = forge.name === "github" ? "PR" : "MR";
        {
          const returned: Candidate = {
            kind: "mr",
            value: words.target,
            source: title
              ? `open ${short} ${words.sign}${iid} — ${title}`
              : `open ${short} ${words.sign}${iid}`,
            label: `${words.sign}${iid}`,
            menuOnly: true,
          };
          return returned;
        }
      },
    ),
  );
  return answer;
}

export function classifyTarget(typed: string, baseRef: string, project: string | null = null) {
  const text = Str.trim(typed);
  if (text === "") {
    const returned: Candidate | null = null;
    return returned;
  }
  const source = "typed";

  const mr = readMrRef(text, { project });
  if (mr) {
    const words = mrWords(mr);
    const returned: Candidate | null = {
      kind: "mr",
      value: words.target,
      source,
      label: `${words.sign}${mr.iid}`,
    };
    return returned;
  }

  if (/^worktree$/i.test(text)) {
    const returned: Candidate | null = {
      kind: "worktree",
      value: "worktree",
      source,
      label: "working tree",
    };
    return returned;
  }

  if (pipe(text, Str.includes("..."))) {
    const returned: Candidate | null = {
      kind: "branch",
      value: `branch:${text}`,
      source,
      label: text,
    };
    return returned;
  }

  if (!baseRef) {
    const returned: Candidate | null = null;
    return returned;
  }
  const returned: Candidate | null = {
    kind: "branch",
    value: `branch:${baseRef}...${text}`,
    source,
    label: text,
  };
  return returned;
}

// WARNING: A pasted merge-request URL is normalised here, or it falls through to worktree on its shape alone.
export function classifyGivenTarget(typed: string, ctx: InferContext) {
  const returned: Effect.Effect<Candidate | null, never, ChildProcessSpawner.ChildProcessSpawner> =
    Effect.gen(function* () {
      // WARNING: An already-normalised target is passed through: classifying it again would nest its prefix.
      const kind = targetKind(Str.trim(typed));
      if (kind !== "") return { kind, value: Str.trim(typed), source: "typed" };
      const run = ctx.run ?? shell;
      const baseRef = (yield* defaultBase(run, ctx.cwd)) ?? "";
      const project = yield* projectHere(ctx.cwd, run);
      return classifyTarget(typed, baseRef, project);
    });
  return returned;
}

export function classifyGivenSet(typed: string, ctx: InferContext) {
  const returned: Effect.Effect<
    { readonly value: string } | { readonly unresolved: string } | null,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > = Effect.gen(function* () {
    const said = mrRefsIn(typed);
    if (said.length < 2) return null;
    const each = yield* Effect.forEach(said, (one) => classifyGivenTarget(one, ctx));
    if (!Arr.some(each, (one) => one?.kind === "mr")) return null;
    const at = Arr.findFirstIndex(each, (one) => one?.kind !== "mr");
    if (Option.isSome(at)) return { unresolved: said[at.value]! };
    return {
      value: Arr.join(
        Arr.map(each, (one) => one!.value),
        " ",
      ),
    };
  });
  return returned;
}

export function linearIssueOf(typed: string) {
  const text = Str.trim(typed);
  const url = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/.exec(text);
  if (url) {
    const returned: string | null = Str.toUpperCase(url[1]!);
    return returned;
  }
  const returned: string | null = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(text)
    ? Str.toUpperCase(text)
    : null;
  return returned;
}

export function classifyWorkSource(typed: string) {
  const returned: Effect.Effect<
    WorkSourceCandidate,
    PlatformError,
    FileSystem.FileSystem | Path.Path
  > = Effect.gen(function* () {
    const path = yield* Path.Path;
    const text = Str.trim(typed);
    const source = "typed";

    // WARNING: Named, never inferred from a path: a follow-up reuses the Run's branch and merge request.
    if (pipe(text, Str.startsWith("followup:")))
      return {
        kind: "followup",
        value: text,
        source,
        label: pipe(text, Str.slice("followup:".length)),
      };

    const issue = linearIssueOf(text);
    if (issue !== null) return { kind: "linear", value: issue, source };

    if (yield* isReviewRun(text))
      return { kind: "review", value: text, source, label: textLabel(path.basename(text)) };

    if (yield* isPlanDir(text))
      return { kind: "plan-dir", value: text, source, label: textLabel(path.basename(text)) };

    return { kind: "text", value: text, source, label: textLabel(text) };
  });
  return returned;
}

function isReviewRun(dir: string) {
  const returned: Effect.Effect<boolean, PlatformError, FileSystem.FileSystem | Path.Path> =
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return (
        dir !== "" &&
        (yield* fs.exists(path.join(dir, REVIEW_FILE))) &&
        (yield* fs.exists(path.join(dir, FINDINGS_FILE)))
      );
    });
  return returned;
}

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
  hint: "!42, #30, owner/repo#30 or a merge or pull request URL, or a base...head range",
  question: "MR iid or URL, or a base...head range",
  classify: (typed, r) => Effect.succeed(classifyTarget(typed, r.base ?? "", r.project ?? null)),
};

function resolveFromMenu<E, R>(r: Resolution, prompts: InputPrompts<E, R>, spec: MenuSpec) {
  const returned: Effect.Effect<boolean, PlatformError | E, FileSystem.FileSystem | Path.Path | R> =
    Effect.gen(function* () {
      const candidates = r.candidates ?? [];
      const items: PickItem[] = Arr.map(candidates, (c, i) => ({
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
        .pipe(Effect.orElseSucceed(() => null));
      if (!chosen) return false;

      if (chosen.id !== TYPE_IT) {
        settle(r, candidates[Number(chosen.id)]!);
        return true;
      }

      const typed = yield* prompts.ask(spec.question).pipe(Effect.orElseSucceed(() => null));
      if (typed === null || Str.trim(typed) === "") return false;
      const classified = yield* spec.classify(typed, r);
      if (!classified) return false;
      settle(r, classified);
      return true;
    });
  return returned;
}

export function resolveCandidates<E, R>(r: Resolution, prompts: InputPrompts<E, R>) {
  const returned: Effect.Effect<boolean, PlatformError | E, FileSystem.FileSystem | Path.Path | R> =
    resolveFromMenu(r, prompts, r.strategy === "diff-target" ? TARGET_MENU : WORK_SOURCE_MENU);
  return returned;
}

export function settle(
  r: Resolution,
  candidate: Pick<WorkSourceCandidate, "value" | "source"> &
    Partial<Pick<WorkSourceCandidate, "kind" | "label">>,
) {
  r.value = candidate.value;
  if (candidate.kind !== undefined) r.kind = candidate.kind;
  r.source = candidate.source;
  if (candidate.label !== undefined) r.label = candidate.label;
  r.needsAsking = false;
  delete r.candidates;
}

function isPlanDir(dir: string) {
  const returned: Effect.Effect<boolean, PlatformError, FileSystem.FileSystem | Path.Path> =
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const info = yield* fs.stat(dir).pipe(Effect.option);
      return (
        Option.isSome(info) &&
        info.value.type === "Directory" &&
        (yield* fs.exists(path.join(dir, "SPEC.md")))
      );
    });
  return returned;
}

function textLabel(text: string) {
  const words = Arr.filter(
    Str.split(pipe(Str.toLowerCase(text), Str.replace(/[^a-z0-9]+/g, " ")), " "),
    Boolean,
  );
  let label = "";
  for (const word of words) {
    const next = label ? `${label}-${word}` : word;
    if (next.length > 24) break;
    label = next;
  }
  return label || "work";
}

export function inputValues(resolutions: Resolution[]) {
  const values: Record<string, string> = {};
  for (const r of resolutions) {
    values[r.name] = r.value;
    if (r.kind) values[`${r.name}_kind`] = r.kind;
  }
  return values;
}

export function confirmLine(
  workflow: string,
  resolutions: Resolution[],
  branch?: { name: string | null; source: string | null } | null,
) {
  const parts = Arr.map(resolutions, (r) => {
    const where =
      r.kind && !pipe(r.value, Str.startsWith(r.kind)) ? `${r.kind} · ${r.source}` : r.source;
    return `${r.name}=${abbreviate(r.value) || "(empty)"} [${where}]`;
  });
  if (branch?.name) parts.push(`branch=${branch.name} [${branch.source ?? "resolved"}]`);
  return `${workflow}: ${Arr.join(parts, "  ")}`;
}

function abbreviate(value: string) {
  return value.length > 60 ? `${pipe(value, Str.slice(0, 57))}...` : value;
}
