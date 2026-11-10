// What GitLab and GitHub say about the merge requests the board is waiting on, asked in
// the background and never from a render: a merge the human did on the forge is the
// strongest signal that the work landed, so Collie records the disposition itself. The
// forge's own checks are kept beside the state, for the card to say whether it is ready.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Struct from "effect/Struct";
import { pipe as pipe_ } from "effect/Function";
import * as Rec from "effect/Record";
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { ForgeFacts } from "./board";
import {
  ForgeChecks,
  Mergeability,
  mrId,
  mrIdProject,
  mrLabel,
  mrRefOf,
  parseMrTarget,
  readMrRef,
  type MrPanel,
  type MrState,
  type TaskView,
} from "./board-model";
import { latest, readDispositions, recordDisposition } from "./disposition";
import { forgeOf } from "./forge/forge";
import type { ReviewRead } from "./forge/review";
import { readLanding, settleLeft } from "./landing";
import { forgeHere, mrIdIn, type Runner } from "./mr";
import { runDir } from "./engine";
import type { RunFacts } from "./runs";
import { diffTargetOf } from "./strategies";
import { epochMs } from "./time";

const isMrTarget = (target: string | null): target is string =>
  target !== null && parseMrTarget(target) !== null;

/** The merge request this Run opened, or the one it was pointed at; null for neither. */
export function mrOf(run: RunFacts): string | null {
  const target = diffTargetOf(run.settled)?.value ?? null;
  return run.mr ?? (isMrTarget(target) ? target : null);
}

/** How long one merge request's answer stands before its forge is asked again. */
export const MERGE_POLL_MS = 5 * 60_000;

/** What the merge watch last read of each merge request, by MR id, and when. */
export type MrPanels = Map<string, { readonly at: number; readonly panel: MrPanel }>;

/**
 * A merge request's panel as the watch last read it, read again only once that is
 * `MERGE_POLL_MS` old or a front door asked for it fresh.
 */
export const watchedMr = Effect.fn("Merges.watchedMr")(function* <R>(opts: {
  readonly panels: MrPanels;
  readonly target: string;
  readonly cwd: string;
  readonly run: Runner<R>;
  readonly now: number;
  readonly fresh: boolean;
}) {
  const ref = mrRefOf(opts.target);
  if (ref === null) return null;
  const id = yield* mrIdIn(opts.target, opts.cwd, opts.run);
  const known = id === null ? undefined : opts.panels.get(id);
  if (known !== undefined && !opts.fresh && known.at + MERGE_POLL_MS > opts.now) return known.panel;
  const panel = yield* forgeOf(ref).details(ref, opts.cwd, opts.run);
  if (id !== null) opts.panels.set(id, { at: opts.now, panel });
  return panel;
});

/** Where the host keeps what its merge watch last learned. */
export const MR_STATES_FILE = "board/mr-states.json";

const StateSchema = Schema.Literals(["open", "merged", "closed", "on-stage", "in-prod"]);
const EntrySchema = Schema.Struct({
  state: StateSchema,
  checks: Schema.optionalKey(ForgeChecks),
  head: Schema.optionalKey(Schema.NullOr(Schema.String)),
  draft: Schema.optionalKey(Schema.Boolean),
  mergeable: Schema.optionalKey(Mergeability),
  source: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.String),
});
const StatesJson = Schema.fromJsonString(Schema.Record(Schema.String, EntrySchema));
/** The shape written before checks were kept: a bare state per merge request. */
const OldStatesJson = Schema.fromJsonString(Schema.Record(Schema.String, StateSchema));
type Entry = typeof EntrySchema.Type;

function stateOf(state: string): MrState {
  const said = Str.toLowerCase(state);
  if (said === "merged") return "merged";
  if (said === "closed") return "closed";
  return "open";
}

/**
 * One round: each branch of a Task with no merge request recorded takes the one opened
 * from it, every Task's and fan-out Repo run's merge request whose answer is stale is asked
 * about, a merged one gets its `merged` disposition recorded as its forge's word, and what
 * was learned is written where `collie --json board` reads it. `checked` and `states` are
 * the caller's memory between rounds; the file is everyone else's.
 */
export const settleMerges = Effect.fn("Merges.settle")(function* <R>(opts: {
  stateDir: string;
  cwd: string;
  run: Runner<R>;
  views: ReadonlyArray<TaskView>;
  /** The Runs the views were built from, which say where each branch was checked out. */
  runs: ReadonlyArray<RunFacts>;
  /** Records a merge request found from a branch as that Run's own. */
  record: (runId: string, url: string) => Effect.Effect<void>;
  /** The host's own audited stop of a Run, for what a merge settled. */
  stop: (runId: string, reason: string) => Effect.Effect<void>;
  gitlabHost?: string;
  now: number;
  checked: Map<string, number>;
  states: Map<string, MrState>;
  /** Where each panel read is kept, for the drawer of the Run it belongs to. */
  panels: MrPanels;
  /** The Run directories whose landing attempt this host process is making now. */
  making: ReadonlySet<string>;
}) {
  // What an earlier host learned, under this one's own answers: a fresh host's empty memory
  // must not ask production again about what an earlier one already saw land there.
  for (const [label, state] of yield* readMrStates(opts.stateDir))
    if (!opts.states.has(label)) opts.states.set(label, state);
  const forge = new Map(yield* readForge(opts.stateDir));
  let learned = false;
  const watched: Array<Watched> = [];
  for (const view of opts.views) {
    const adopted = yield* fromBranches(view, opts);
    const found = view.mr === null ? adopted[0] : undefined;
    const mr = view.mr ?? found?.url ?? null;
    const repos = Arr.flatMap(view.children, (child) =>
      child.run === null || child.mr === null ? [] : [{ run: child.run, mr: child.mr }],
    );
    // A card of several merge requests watches each as the Run that owns it alone.
    const several = (view.mrs?.length ?? 0) > 1;
    // A card showing its one Repo run's merge request watches it as that Repo run's.
    const shown = several
      ? undefined
      : Option.getOrUndefined(
          Arr.findFirst(
            repos,
            (repo) => mr !== null && mrId(repo.mr) !== null && mrId(repo.mr) === mrId(mr),
          ),
        );
    if (mr !== null && !several)
      watched.push({
        mr,
        disposition: view.disposition,
        runs: shown === undefined ? view.runs : [...view.runs, shown.run],
        owner: shown?.run ?? found?.run ?? view.mrs?.[0]?.run ?? view.run,
      });
    for (const repo of repos)
      if (repo !== shown)
        watched.push({
          mr: repo.mr,
          disposition: yield* dispositionIn(runDir(opts.stateDir, repo.run)),
          runs: [repo.run],
          owner: repo.run,
        });
    for (const one of adopted)
      if (one !== found)
        watched.push({ mr: one.url, disposition: null, runs: [one.run], owner: one.run });
    if (several)
      for (const entry of view.mrs!)
        if (!Arr.some(repos, (repo) => repo.run === entry.run))
          watched.push({
            mr: entry.mr,
            disposition: entry.disposition,
            runs: [entry.run],
            owner: entry.run,
          });
  }
  for (const { mr, disposition, runs, owner } of watched) {
    // A merged one is still followed to its deploy jobs, until production has it.
    if (disposition !== null && !pipe_(disposition, Str.startsWith("merged"))) continue;
    const label = mrLabel(mr);
    if (mrRefOf(mr) === null) continue;
    const at =
      Option.getOrUndefined(Arr.findFirst(opts.runs, (run) => run.id === owner))?.cwd ?? opts.cwd;
    const id = yield* mrIdIn(mr, at, opts.run);
    if (id === null) continue;
    const dirs = Arr.map(runs, (run) => runDir(opts.stateDir, run));
    if (
      opts.states.get(id) !== "in-prod" &&
      (opts.checked.get(id) ?? 0) + MERGE_POLL_MS <= opts.now
    ) {
      // Stamped before asking: a forge that cannot be asked is not asked again every tick.
      opts.checked.set(id, opts.now);
      const answered = yield* forgeAnswer(mr, at, opts.run, (panel) =>
        opts.panels.set(id, { at: opts.now, panel }),
      );
      if (answered !== null) {
        const { state, facts, by, mergedAt } = answered;
        if (opts.states.get(id) !== state || !sameFacts(forge.get(id), facts)) learned = true;
        opts.states.set(id, state);
        forge.set(id, facts);
        if (state !== "open" && state !== "closed" && (yield* firstMerged(dirs, id)) === null)
          yield* recordDisposition(runDir(opts.stateDir, owner), {
            at: mergedAt ?? DateTime.formatIso(DateTime.makeUnsafe(opts.now)),
            by,
            kind: "merged",
            ref: id,
            note: null,
          });
      }
    }
    // Every round, not only when the forge is asked: a stop that did not take is asked again.
    const state = opts.states.get(id);
    if (state === undefined || state === "open" || state === "closed") continue;
    const read = opts.panels.get(id)?.panel;
    // ponytail: the forge's time lives as long as this host's panels; a new host asks again.
    const merged =
      read?._tag === "Details" && read.mergedAt !== undefined
        ? epochMs(read.mergedAt)
        : yield* firstMerged(dirs, id);
    if (merged === null) continue;
    const working = withWaitingParents(
      yield* workingOn(id, owner, forge.get(id)?.source, opts),
      opts.runs,
    );
    const going = Arr.filter(
      opts.runs,
      (run) =>
        working.includes(run.id) &&
        (run.state === "running" || run.state === "waiting") &&
        epochMs(run.created) < merged,
    );
    if (going.length === 0) continue;
    const spared = yield* sparedBy(id, working, opts);
    // An attempt the forge cannot settle yet spares nothing and stops nothing.
    if (spared === null) continue;
    for (const run of going) if (!spared.has(run.id)) yield* opts.stop(run.id, `${label} merged`);
  }
  if (learned) yield* writeMrStates(opts.stateDir, opts.states, forge);
});

/**
 * The ids of the Runs whose work is the merge request `id`, whichever Task they are in: its
 * owner, each given it, and each on its source branch in its owner's checkout.
 */
const workingOn = Effect.fn("Merges.workingOn")(function* <R>(
  id: string,
  owner: string,
  source: string | undefined,
  opts: { readonly runs: ReadonlyArray<RunFacts>; readonly run: Runner<R> },
) {
  const owning = Option.getOrUndefined(Arr.findFirst(opts.runs, (run) => run.id === owner));
  const branch = source ?? owning?.branch ?? null;
  const ids: Array<string> = [];
  for (const run of opts.runs) {
    const mr = mrOf(run);
    if (
      run.id === owner ||
      (branch !== null && run.branch === branch && run.project === owning?.project) ||
      (mr !== null && (yield* mrIdIn(mr, run.cwd, opts.run)) === id)
    )
      ids.push(run.id);
  }
  return ids;
});

/**
 * `ids`, and each Run all of whose going children are among them. A fan-out is never one:
 * its Changes of a later wave are not admitted yet.
 */
function withWaitingParents(ids: ReadonlyArray<string>, runs: ReadonlyArray<RunFacts>) {
  const working = new Set(ids);
  const going = (run: RunFacts) => run.state === "running" || run.state === "waiting";
  let grew = true;
  while (grew) {
    grew = false;
    for (const run of runs) {
      if (working.has(run.id)) continue;
      const children = Arr.filter(runs, (child) => child.parent === run.id);
      if (
        !Arr.some(children, (child) => child.repo !== null) &&
        Arr.some(children, (child) => working.has(child.id)) &&
        Arr.every(children, (child) => working.has(child.id) || !going(child))
      ) {
        working.add(run.id);
        grew = true;
      }
    }
  }
  return [...working];
}

/**
 * The Runs a merge of the merge request `id` leaves running: each whose landing of it is landed, being made
 * by this process, or settled as landed now, and every Run up its parent chain. Null where
 * an attempt an earlier process left cannot be settled yet.
 */
const sparedBy = Effect.fn("Merges.sparedBy")(function* <R>(
  id: string,
  /** The ids of the Runs that land it. */
  ids: ReadonlyArray<string>,
  opts: {
    readonly run: Runner<R>;
    readonly runs: ReadonlyArray<RunFacts>;
    readonly making: ReadonlySet<string>;
  },
) {
  const ref = readMrRef(`mr:${id}`);
  const landers: Array<string> = [];
  let read: ReviewRead | undefined;
  for (const run of Arr.filter(opts.runs, (one) => ids.includes(one.id))) {
    const landing = yield* readLanding(run.dir);
    if (
      landing === null ||
      (yield* mrIdIn(landing.mr, run.cwd, opts.run)) !== id ||
      landing.state === "withdrawn"
    )
      continue;
    if (landing.state === "landed" || opts.making.has(run.dir)) {
      landers.push(run.id);
      continue;
    }
    if (ref === null) return null;
    read ??= yield* forgeOf(ref).readReview(ref, run.cwd, opts.run);
    if (!read.ok) return null;
    const settled = yield* settleLeft(run.dir, landing, read).pipe(Effect.orDie);
    if (settled._tag === "Unmerged") return null;
    if (settled._tag === "Landed") landers.push(run.id);
  }
  const parentOf = new Map(Arr.map(opts.runs, (run) => [run.id, run.parent]));
  const spared = new Set<string>();
  for (const lander of landers) {
    let at: string | null = lander;
    while (at !== null && !spared.has(at)) {
      spared.add(at);
      at = parentOf.get(at) ?? null;
    }
  }
  return spared;
});

/** A merge request the watch follows, and the Runs it lands. */
interface Watched {
  readonly mr: string;
  /** What became of its work, as `kind ref`; null where nobody said. */
  readonly disposition: string | null;
  readonly runs: ReadonlyArray<string>;
  /** The Run its `merged` disposition is recorded on. */
  readonly owner: string;
}

/** A Run's latest disposition, as a card says one. */
const dispositionIn = Effect.fn("Merges.dispositionIn")(function* (dir: string) {
  const line = latest(yield* readDispositions(dir).pipe(Effect.orElseSucceed(() => [])));
  return line === null ? null : line.ref === "" ? line.kind : `${line.kind} ${line.ref}`;
});

/**
 * When the Task's merge request merged, as its first `merged` Disposition says; null for none.
 * A hostless ref an earlier host wrote is read as in `id`'s project.
 */
const firstMerged = Effect.fn("Merges.firstMerged")(function* (
  dirs: ReadonlyArray<string>,
  id: string,
) {
  const project = mrIdProject(id);
  let first: number | null = null;
  for (const dir of dirs)
    for (const line of yield* readDispositions(dir).pipe(Effect.orElseSucceed(() => [])))
      if (
        line.kind === "merged" &&
        mrId(line.ref, { project }) === id &&
        (first === null || epochMs(line.at) < first)
      )
        first = epochMs(line.at);
  return first;
});

/**
 * The merge requests opened from the Task's branches that have none recorded, by whoever
 * opened them, each recorded as the newest Run's on its branch; none where the forge cannot
 * say. A merge request that merged or closed before the Task's first Run is an older branch's.
 */
const fromBranches = Effect.fn("Merges.fromBranches")(function* <R>(
  view: TaskView,
  opts: {
    readonly runs: ReadonlyArray<RunFacts>;
    readonly run: Runner<R>;
    readonly record: (runId: string, url: string) => Effect.Effect<void>;
    readonly gitlabHost?: string;
    readonly checked: Map<string, number>;
    readonly now: number;
  },
) {
  if (view.mr === null && view.disposition !== null) return [];
  const runs = Arr.filter(opts.runs, (run) => view.runs.includes(run.id));
  const branchOf = (run: RunFacts) => `branch:${run.project}:${run.branch}`;
  const owned = new Set(
    Arr.map(
      Arr.filter(runs, (run) => mrOf(run) !== null),
      branchOf,
    ),
  );
  const newest = new Map<string, RunFacts>();
  for (const run of runs) {
    const key = branchOf(run);
    const known = newest.get(key);
    if (
      run.branch !== null &&
      !owned.has(key) &&
      (known === undefined || epochMs(run.created) > epochMs(known.created))
    )
      newest.set(key, run);
  }
  const began = Math.min(...Arr.map(runs, (run) => epochMs(run.created)));
  const found: Array<{ readonly run: string; readonly url: string }> = [];
  for (const [key, run] of newest) {
    if ((opts.checked.get(key) ?? 0) + MERGE_POLL_MS > opts.now) continue;
    opts.checked.set(key, opts.now);
    const here = yield* forgeHere(run.project, opts.run, opts.gitlabHost);
    if (!here.ok) continue;
    const listed = yield* here.forge.fromBranch(here.project, run.branch!, run.project, opts.run);
    if (!listed.ok) continue;
    const mr = Arr.filter(
      listed.mrs,
      (one) => one.ended === null || epochMs(one.ended) >= began,
    ).sort((a, b) => epochMs(b.created) - epochMs(a.created))[0];
    if (mr === undefined) continue;
    yield* opts.record(run.id, mr.url);
    found.push({ run: run.id, url: mr.url });
  }
  return found;
});

const sameFacts = (a: ForgeFacts | undefined, b: ForgeFacts) =>
  a !== undefined &&
  a.head === b.head &&
  a.checks.state === b.checks.state &&
  ("name" in a.checks ? a.checks.name : "") === ("name" in b.checks ? b.checks.name : "") &&
  a.draft === b.draft &&
  a.mergeable?.state === b.mergeable?.state &&
  a.mergeable?.said === b.mergeable?.said &&
  a.source === b.source &&
  a.target === b.target;

/**
 * One merge request's state and checks, from whichever forge it is on, or null where that
 * forge cannot be asked. Never an error: a card with no answer reads `unchecked`.
 */
const forgeAnswer = Effect.fn("Merges.forgeAnswer")(function* <R>(
  mr: string,
  cwd: string,
  run: Runner<R>,
  /** Keeps a panel read, for the drawer of the Run it belongs to. */
  remember: (panel: MrPanel) => void,
) {
  const ref = mrRefOf(mr);
  if (ref === null) return null;
  const forge = forgeOf(ref);
  const panel = yield* forge.details(ref, cwd, run);
  remember(panel);
  if (panel._tag !== "Details") return null;
  let state = stateOf(panel.state);
  if (state === "merged") {
    const tier = yield* forge.liveTier(ref, panel.mergedSha, cwd, run);
    state = tier === "production" ? "in-prod" : tier === "staging" ? "on-stage" : "merged";
  }
  const facts: ForgeFacts = {
    checks: panel.checks ?? { state: "unknown" },
    head: (panel.head ?? "") === "" ? null : panel.head!,
    draft: panel.state === "draft",
    source: panel.sourceBranch,
    target: panel.targetBranch,
  };
  return {
    state,
    facts: panel.mergeable === undefined ? facts : { ...facts, mergeable: panel.mergeable },
    by: forge.name,
    mergedAt: panel.mergedAt,
  };
});

/**
 * Merged over what is there, never a replacement: every board pane keeps only what it has
 * itself asked, and a fresh pane writing its few answers over the file would take from the
 * CLI's board what an earlier pane had learned.
 */
export const writeMrStates = Effect.fn("Merges.write")(function* (
  stateDir: string,
  states: ReadonlyMap<string, MrState>,
  forge: ReadonlyMap<string, ForgeFacts> = new Map(),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(stateDir, MR_STATES_FILE);
  const entries = new Map(yield* readEntries(stateDir));
  for (const [label, state] of states) {
    const facts = forge.get(label) ?? factsOf(entries.get(label));
    entries.set(label, facts === null ? { state } : { state, ...facts });
  }
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(
    file,
    `${yield* Schema.encodeEffect(StatesJson)(Rec.fromEntries(entries)).pipe(Effect.orDie)}\n`,
  );
});

/** What the last watch wrote, or nothing: a host that never watched has never asked a forge. */
const readEntries = Effect.fn("Merges.readEntries")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(stateDir, MR_STATES_FILE))
    .pipe(Effect.orElseSucceed(() => "{}"));
  const decoded = Schema.decodeOption(StatesJson)(text);
  if (Option.isSome(decoded)) return new Map<string, Entry>(Rec.toEntries(decoded.value));
  // An unreadable file is no memory, not a failure: the next watch rewrites it.
  const old = Option.getOrElse(Schema.decodeOption(OldStatesJson)(text), () => ({}));
  return new Map<string, Entry>(
    Arr.map(Rec.toEntries(old), ([label, state]) => [label, { state }]),
  );
});

const factsOf = (entry: Entry | undefined): ForgeFacts | null => {
  if (entry?.checks === undefined) return null;
  return { ...Struct.omit(entry, ["state"]), checks: entry.checks, head: entry.head ?? null };
};

/** Each merge request's state, as the last watch learned it. */
export const readMrStates = Effect.fn("Merges.read")(function* (stateDir: string) {
  const entries = yield* readEntries(stateDir);
  return new Map(Arr.map([...entries], ([label, entry]) => [label, entry.state]));
});

/** What the forge said of each merge request's checks; an entry in the old shape has none. */
export const readForge = Effect.fn("Merges.readForge")(function* (stateDir: string) {
  const found = new Map<string, ForgeFacts>();
  for (const [label, entry] of yield* readEntries(stateDir)) {
    const facts = factsOf(entry);
    if (facts !== null) found.set(label, facts);
  }
  return found;
});
