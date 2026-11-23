import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Struct from "effect/Struct";
import { DateTime, Effect, FileSystem, Option } from "effect";
import { MergeRequests } from "./merge-requests";
import type { MergeRequestsApi, MrEntry } from "./merge-requests";
import type { ForgeFacts } from "./board";
import { readEnv } from "./env";
import {
  Mergeability,
  mrId,
  mrIdProject,
  mrLabel,
  mrRefOf,
  parseMrTarget,
  readMrRef,
} from "./board-model";
import type { MrPanel, MrState, TaskView } from "./board-model";
import { latest, readDispositions, recordDisposition } from "./disposition";
import { forgeOf } from "./forge/forge";
import type { ReviewRead } from "./forge/review";
import { readLanding, settleLeft } from "./landing";
import { forgeHere, mrIdIn } from "./mr";
import type { Runner } from "./mr";
import { runDir } from "./engine";
import type { RunFacts } from "./runs";
import { diffTargetOf } from "./strategies";
import { epochMs } from "./time";

const isMrTarget = (target: string | null): target is string =>
  target !== null && parseMrTarget(target) !== null;

export function mrOf(run: RunFacts) {
  const target = diffTargetOf(run.settled)?.value ?? null;
  const returned: string | null = run.mr ?? (isMrTarget(target) ? target : null);
  return returned;
}

export { MERGE_POLL_MS } from "./shipping";
import { MERGE_POLL_MS } from "./shipping";

/** How often an open merge request on a card the board shows is read. */
export const MERGE_SYNC_MS = 60_000;

/** What the merge watch last read of each merge request, by MR id, and when. */
export type MrPanels = Map<string, { readonly at: number; readonly panel: MrPanel }>;

export const watchedMr = Effect.fn("Merges.watchedMr")(function* <R>(opts: {
  readonly stateDir: string;
  readonly panels: MrPanels;
  readonly target: string;
  readonly cwd: string;
  readonly run: Runner<R>;
  readonly now: number;
  readonly fresh: boolean;
}) {
  const ref = mrRefOf(opts.target);
  if (ref === null) {
    return null;
  }
  const id = yield* mrIdIn(opts.target, opts.cwd, opts.run);
  const known = id === null ? undefined : opts.panels.get(id);
  if (known !== undefined && !opts.fresh && known.at + MERGE_POLL_MS > opts.now) {
    return known.panel;
  }
  const fs = yield* FileSystem.FileSystem;
  const cwd = (yield* fs.exists(opts.cwd).pipe(Effect.orElseSucceed(() => false)))
    ? opts.cwd
    : opts.stateDir;
  const resolved = id === null ? ref : mrRefOf(`mr:${id}`)!;
  const panel = yield* forgeOf(resolved).details(resolved, cwd, opts.run);
  if (id !== null) {
    opts.panels.set(id, { at: opts.now, panel });
  }
  if (id !== null) {
    const states = yield* readMrStates(opts.stateDir);
    const facts = yield* readForge(opts.stateDir);
    const now = DateTime.formatIso(DateTime.makeUnsafe(opts.now));
    if (panel._tag === "Details") {
      const state = stateOf(panel.state);
      const known = states.get(id);
      states.set(
        id,
        state === "merged" && (known === "on-stage" || known === "in-prod") ? known : state,
      );
      facts.set(id, { ...panelFacts(panel), read: now, asked: now });
    } else {
      facts.set(id, {
        ...(facts.get(id) ?? { checks: { state: "unknown" }, head: null }),
        asked: now,
      });
    }
    yield* writeMrStates(opts.stateDir, states, facts).pipe(Effect.orDie);
  }
  return panel;
});

export { MR_STATES_FILE } from "./merge-requests";
type Entry = MrEntry;

const stateOf: (state: string) => MrState = (state) => {
  const said = Str.toLowerCase(state);
  if (said === "merged") {
    return "merged";
  }
  if (said === "closed") {
    return "closed";
  }
  return "open";
};

export const settleMerges = Effect.fn("Merges.settle")(function* <R>(opts: {
  stateDir: string;
  cwd: string;
  run: Runner<R>;
  views: ReadonlyArray<TaskView>;
  runs: ReadonlyArray<RunFacts>;
  record: (runId: string, url: string) => Effect.Effect<void>;
  stop: (runId: string, reason: string) => Effect.Effect<void>;
  gitlabHost?: string;
  now: number;
  checked: Map<string, number>;
  states: Map<string, MrState>;
  panels: MrPanels;
  making: ReadonlySet<string>;
  /** Merge requests to ask about this round, whenever they were last read: a Run just pushed to them. */
  nudged?: Set<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  // WARNING: Earlier hosts' answers are merged in, so a fresh host does not re-ask what already landed.
  for (const [label, state] of yield* readMrStates(opts.stateDir)) {
    opts.states.set(label, state);
  }
  const forge = new Map(yield* readForge(opts.stateDir));
  let asked = false;
  const watched: Array<Watched & { readonly visible: boolean }> = [];
  const requests = yield* MergeRequests;
  const nudged = new Set(opts.nudged ?? []);
  opts.nudged?.clear();
  const shown = new Set(
    Arr.flatMap(opts.views, (view) => [
      ...view.runs,
      ...Arr.flatMap(view.children, (child) => (child.run === null ? [] : [child.run])),
    ]),
  );
  const hidden = Arr.some(opts.runs, (run) => !shown.has(run.id))
    ? yield* (yield* Effect.promise(() => import("./board"))).buildBoard({
        env: readEnv({ COLLIE_STATE_DIR: opts.stateDir, COLLIE_CWD: opts.cwd }),
        runs: opts.runs,
        includeHistory: true,
        now: opts.now,
        offers: () => Effect.succeed([]),
      })
    : [];
  const visible = new Set(opts.views);
  for (const view of [
    ...opts.views,
    ...Arr.filter(hidden, (view) => !Arr.some(view.runs, (run) => shown.has(run))),
  ]) {
    const onBoard = visible.has(view);
    const adopted = yield* fromBranches(view, opts);
    const found = view.mr === null ? adopted[0] : undefined;
    const mr = view.mr ?? found?.url ?? null;
    const repos = Arr.flatMap(view.children, (child) =>
      child.run === null || child.mr === null ? [] : [{ run: child.run, mr: child.mr }],
    );
    const several = (view.mrs?.length ?? 0) > 1;
    const shown = several
      ? undefined
      : Option.getOrUndefined(
          Arr.findFirst(
            repos,
            (repo) => mr !== null && mrId(repo.mr) !== null && mrId(repo.mr) === mrId(mr),
          ),
        );
    if (mr !== null && !several) {
      watched.push({
        visible: onBoard,
        mr,
        abandoned: view.mrs?.[0]?.settled === "abandoned",
        runs: shown === undefined ? view.runs : [...view.runs, shown.run],
        owner: shown?.run ?? found?.run ?? view.mrs?.[0]?.run ?? view.run,
      });
    }
    for (const repo of repos) {
      if (repo !== shown) {
        watched.push({
          visible: onBoard,
          mr: repo.mr,
          abandoned: yield* abandonedIn(runDir(opts.stateDir, repo.run)),
          runs: [repo.run],
          owner: repo.run,
        });
      }
    }
    for (const one of adopted) {
      if (one !== found) {
        watched.push({
          visible: onBoard,
          mr: one.url,
          abandoned: false,
          runs: [one.run],
          owner: one.run,
        });
      }
    }
    if (several) {
      for (const entry of view.mrs!) {
        if (!Arr.some(repos, (repo) => repo.run === entry.run)) {
          watched.push({
            visible: onBoard,
            mr: entry.mr,
            abandoned: entry.settled === "abandoned",
            runs: [entry.run],
            owner: entry.run,
          });
        }
      }
    }
  }
  for (const { mr, abandoned, runs, owner, visible } of watched) {
    // WARNING: Only an abandonment settles a merge request for good; a closed one may be reopened.
    if (abandoned) {
      continue;
    }
    const label = mrLabel(mr);
    if (mrRefOf(mr) === null) {
      continue;
    }
    const checkout =
      Option.getOrUndefined(Arr.findFirst(opts.runs, (run) => run.id === owner))?.cwd ?? opts.cwd;
    const at = (yield* fs.exists(checkout))
      ? checkout
      : (yield* fs.exists(opts.cwd))
        ? opts.cwd
        : opts.stateDir;
    const id = yield* mrIdIn(mr, checkout, opts.run);
    if (id === null) {
      continue;
    }
    const dirs = Arr.map(runs, (run) => runDir(opts.stateDir, run));
    // An open one on a card the board shows is read each minute, the rest every 5 minutes.
    const known = opts.states.get(id);
    const every =
      visible && (known === undefined || known === "open") ? MERGE_SYNC_MS : MERGE_POLL_MS;
    if (
      known !== "in-prod" &&
      (nudged.has(mr) ||
        nudged.has(id) ||
        Math.max(
          opts.checked.get(id) ?? 0,
          epochMs(forge.get(id)?.asked ?? forge.get(id)?.read ?? "") || 0,
        ) +
          every <=
          opts.now)
    ) {
      // WARNING: Stamped before asking, so a forge that cannot be asked is not asked every tick.
      opts.checked.set(id, opts.now);
      asked = true;
      const answered = yield* forgeAnswer(`mr:${id}`, at, opts.run, (panel) =>
        opts.panels.set(id, { at: opts.now, panel }),
      );
      const now = DateTime.formatIso(DateTime.makeUnsafe(opts.now));
      if (answered === null) {
        const known = forge.get(id);
        forge.set(id, { ...(known ?? { checks: { state: "unknown" }, head: null }), asked: now });
      } else {
        const { state, facts, by, mergedAt } = answered;
        opts.states.set(id, state);
        forge.set(id, { ...facts, read: now, asked: now });
        yield* keepLogin(requests, id, at, opts.run, opts.now);
        if (state !== "open" && state !== "closed" && (yield* firstMerged(dirs, id)) === null) {
          yield* recordDisposition(runDir(opts.stateDir, owner), {
            at: mergedAt ?? now,
            by,
            kind: "merged",
            ref: id,
            note: null,
          });
        }
      }
    }
    // WARNING: Every round, not only when asked: a stop that did not take is asked again.
    const state = opts.states.get(id);
    if (state === undefined || state === "open" || state === "closed") {
      continue;
    }
    const read = opts.panels.get(id)?.panel;
    const merged =
      read?._tag === "Details" && read.mergedAt !== undefined
        ? epochMs(read.mergedAt)
        : yield* firstMerged(dirs, id);
    if (merged === null) {
      continue;
    }
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
    if (going.length === 0) {
      continue;
    }
    const spared = yield* sparedBy(id, working, opts);
    // WARNING: An attempt the forge cannot settle yet spares and stops nothing.
    if (spared === null) {
      continue;
    }
    for (const run of going) {
      if (!spared.has(run.id)) {
        yield* opts.stop(run.id, `${label} merged`);
      }
    }
  }
  if (asked) {
    yield* writeMrStates(opts.stateDir, opts.states, forge);
  }
});

/** How long who Collie is on a forge host stands before the syncer asks again. */
const LOGIN_EVERY_MS = 60 * 60_000;

/** Who Collie is on the merge request's forge host, kept with when it was read, asked hourly. */
const keepLogin = Effect.fn("Merges.keepLogin")(function* <R>(
  requests: MergeRequestsApi,
  id: string,
  cwd: string,
  run: Runner<R>,
  now: number,
) {
  const ref = mrRefOf(`mr:${id}`);
  const host = Str.split(id, "/")[0] ?? "";
  if (ref === null || host === "") {
    return;
  }
  const kept = yield* requests.login(host);
  if (kept !== null && kept.login !== null && kept.read + LOGIN_EVERY_MS > now) {
    return;
  }
  const login = yield* forgeOf(ref).login(cwd, run, ref.project);
  // A login that could not be read keeps the last one known, as an answer the forge could not give does.
  if (login === null && kept !== null) {
    return;
  }
  yield* requests.putLogin(host, { login, read: now });
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
    ) {
      ids.push(run.id);
    }
  }
  return ids;
});

function withWaitingParents(ids: ReadonlyArray<string>, runs: ReadonlyArray<RunFacts>) {
  const working = new Set(ids);
  const going = (run: RunFacts) => run.state === "running" || run.state === "waiting";
  let grew = true;
  while (grew) {
    grew = false;
    for (const run of runs) {
      if (working.has(run.id)) {
        continue;
      }
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

const sparedBy = Effect.fn("Merges.sparedBy")(function* <R>(
  id: string,
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
    ) {
      continue;
    }
    if (landing.state === "landed" || opts.making.has(run.dir)) {
      landers.push(run.id);
      continue;
    }
    if (ref === null) {
      return null;
    }
    read ??= yield* forgeOf(ref).readReview(ref, run.cwd, opts.run);
    if (!read.ok) {
      return null;
    }
    const settled = yield* settleLeft(run.dir, landing, read).pipe(Effect.orDie);
    if (settled._tag === "Unmerged") {
      return null;
    }
    if (settled._tag === "Landed") {
      landers.push(run.id);
    }
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

interface Watched {
  readonly mr: string;
  readonly abandoned: boolean;
  readonly runs: ReadonlyArray<string>;
  readonly owner: string;
}

const abandonedIn = Effect.fn("Merges.abandonedIn")(function* (dir: string) {
  return (
    latest(yield* readDispositions(dir).pipe(Effect.orElseSucceed(() => [])))?.kind === "abandoned"
  );
});

// WARNING: A hostless ref an earlier host wrote is read in the id's project.
const firstMerged = Effect.fn("Merges.firstMerged")(function* (
  dirs: ReadonlyArray<string>,
  id: string,
) {
  const project = mrIdProject(id);
  let first: number | null = null;
  for (const dir of dirs) {
    for (const line of yield* readDispositions(dir).pipe(Effect.orElseSucceed(() => []))) {
      if (
        line.kind === "merged" &&
        mrId(line.ref, { project }) === id &&
        (first === null || epochMs(line.at) < first)
      ) {
        first = epochMs(line.at);
      }
    }
  }
  return first;
});

// WARNING: A merge request merged or closed before the Task's first Run is an older branch's.
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
  if (view.mr === null && view.landed) {
    return [];
  }
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
    ) {
      newest.set(key, run);
    }
  }
  const began = Math.min(...Arr.map(runs, (run) => epochMs(run.created)));
  const found: Array<{ readonly run: string; readonly url: string }> = [];
  for (const [key, run] of newest) {
    if ((opts.checked.get(key) ?? 0) + MERGE_POLL_MS > opts.now) {
      continue;
    }
    opts.checked.set(key, opts.now);
    const here = yield* forgeHere(run.project, opts.run, opts.gitlabHost);
    if (!here.ok) {
      continue;
    }
    const listed = yield* here.forge.fromBranch(here.project, run.branch!, run.project, opts.run);
    if (!listed.ok) {
      continue;
    }
    const mr = Arr.filter(
      listed.mrs,
      (one) => one.ended === null || epochMs(one.ended) >= began,
    ).sort((a, b) => epochMs(b.created) - epochMs(a.created))[0];
    if (mr === undefined) {
      continue;
    }
    yield* opts.record(run.id, mr.url);
    found.push({ run: run.id, url: mr.url });
  }
  return found;
});

// WARNING: Never an error: a card with no answer reads unchecked.
const forgeAnswer = Effect.fn("Merges.forgeAnswer")(function* <R>(
  mr: string,
  cwd: string,
  run: Runner<R>,
  remember: (panel: MrPanel) => void,
) {
  const ref = mrRefOf(mr);
  if (ref === null) {
    return null;
  }
  const forge = forgeOf(ref);
  const panel = yield* forge.details(ref, cwd, run);
  remember(panel);
  if (panel._tag !== "Details") {
    return null;
  }
  let state = stateOf(panel.state);
  if (state === "merged") {
    const tier = yield* forge.liveTier(ref, panel.mergedSha, cwd, run);
    state = tier === "production" ? "in-prod" : tier === "staging" ? "on-stage" : "merged";
  }
  return {
    state,
    facts: panelFacts(panel),
    by: forge.name,
    mergedAt: panel.mergedAt,
  };
});

const panelFacts: (panel: Extract<MrPanel, { _tag: "Details" }>) => ForgeFacts = (panel) => {
  const facts: ForgeFacts = {
    checks: panel.checks ?? { state: "unknown" },
    head: (panel.head ?? "") === "" ? null : panel.head!,
    draft: panel.state === "draft",
    source: panel.sourceBranch,
    target: panel.targetBranch,
    author: panel.author,
    approvals: panel.approvals,
    unresolved: panel.unresolved,
  };
  return panel.mergeable === undefined ? facts : { ...facts, mergeable: panel.mergeable };
};

/** Merged over what is kept, never a replacement: the newer read of each stands. */
export const writeMrStates = Effect.fn("Merges.write")(function* (
  _stateDir: string,
  states: ReadonlyMap<string, MrState>,
  forge: ReadonlyMap<string, ForgeFacts> = new Map(),
) {
  const requests = yield* MergeRequests;
  const known = yield* requests.entries;
  const entries = new Map<string, Entry>();
  for (const [label, state] of states) {
    const facts = forge.get(label) ?? factsOf(known.get(label));
    entries.set(label, facts === null ? { state } : { state, ...facts });
  }
  for (const [label, facts] of forge) {
    if (!states.has(label)) {
      entries.set(label, { ...known.get(label), ...facts });
    }
  }
  yield* requests.merge(entries);
});

/** What the watch last learned, or nothing: a host that never watched has never asked a forge. */
const readEntries = Effect.fn("Merges.readEntries")(function* (_stateDir: string) {
  return yield* MergeRequests.use((requests) => requests.entries);
});

const factsOf: (entry: Entry | undefined) => ForgeFacts | null = (entry) => {
  if (entry?.checks === undefined) {
    return null;
  }
  return { ...Struct.omit(entry, ["state"]), checks: entry.checks, head: entry.head ?? null };
};

const answers = Effect.fn("Merges.answers")(function* (stateDir: string) {
  return Arr.filter([...(yield* readEntries(stateDir))], ([, entry]) => entry.read !== undefined);
});

export const readMrStates = Effect.fn("Merges.read")(function* (stateDir: string) {
  return new Map(
    Arr.flatMap(yield* answers(stateDir), ([label, entry]) =>
      entry.state === undefined ? [] : [[label, entry.state] as const],
    ),
  );
});

export const readForge = Effect.fn("Merges.readForge")(function* (stateDir: string) {
  const found = new Map<string, ForgeFacts>();
  for (const [label, entry] of yield* readEntries(stateDir)) {
    if (entry.read === undefined && entry.asked === undefined) {
      continue;
    }
    const facts = factsOf(entry);
    if (facts !== null) {
      found.set(label, facts);
    }
  }
  return found;
});
