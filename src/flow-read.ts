// A Task's Flow as the host builds it: each Run's records read from its directory, its
// launches and the engine's facts, with the waits and the merge request its card reads,
// handed to `flow.ts`'s rules.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Clock, Effect, FileSystem } from "effect";
import type { Flow, FlowLane, FlowNode, FlowRun, MrState } from "./board-model";
import { mrRefOf, mrUrlOf } from "./board-model";
import { readAudit, whoActed } from "./audit";
import type { PluginEnv } from "./env";
import {
  currentOf,
  flowNotice,
  laneOf,
  linkSaid,
  linkState,
  releaseRow,
  type ChildFact,
  type Execution,
  type LaneWait,
} from "./flow";
import { readLaunches } from "./launches";
import { runTitle } from "./naming";
import { machineName } from "./peers";
import type { RunFacts, RunState } from "./runs";
import { readStepLines } from "./steps";
import { readStepSteering } from "./step-steering";
import { usualStepTimes } from "./step-durations";
import { readRunLinks } from "./run-links";
import { epochMs } from "./time";
import { readVerifications } from "./verify";

const executionOfState = (state: RunState): Execution => {
  switch (state) {
    case "running":
      return "running";
    case "waiting":
      return "suspended";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
};

/** What a lane is given beside its own records: what the Task around it knows. */
export interface LaneContext {
  readonly children: ReadonlyArray<ChildFact>;
  readonly toCome: ReadonlyArray<{ readonly repo: string; readonly wave: number }>;
  readonly wait: LaneWait | null;
  readonly offer: { readonly id: string; readonly title: string } | null;
  readonly readiness: string | null;
}

const ALONE: LaneContext = { children: [], toCome: [], wait: null, offer: null, readiness: null };

const machineOf = (env: PluginEnv) => env.machine ?? machineName();

const requestedLink = (notice: {
  readonly run: string;
  readonly workflow: string;
  readonly machine: { readonly name: string; readonly installation: string };
  readonly state: FlowRun["state"];
  readonly said: string | null;
  readonly at: string | null;
  readonly canResume?: boolean;
}): FlowRun => ({
  id: `run:${notice.machine.installation}:${notice.run}`,
  title: `${Option.getOrUndefined(Option.map(Option.fromNullishOr(notice.workflow[0]), (present) => Str.toUpperCase(present))) ?? ""}${pipe_(notice.workflow, Str.slice(1))} on ${notice.machine.name}`,
  kind: "link",
  description: "",
  role: null,
  declared: false,
  state: notice.state,
  said: notice.said,
  wait: null,
  produces: null,
  offPath: false,
  place: null,
  started: null,
  ended: null,
  attempts: [],
  ranOn: null,
  questions: [],
  link: {
    run: notice.run,
    machine: notice.machine.name,
    state: notice.state,
    said: notice.said,
    asOf: notice.at,
    canResume: notice.canResume,
  },
});

/** One Run's row, from what it recorded and what its Task says around it. */
export const laneFor = Effect.fn("Flow.lane")(function* (
  env: PluginEnv,
  run: RunFacts,
  context: LaneContext = ALONE,
) {
  const fs = yield* FileSystem.FileSystem;
  const launches = yield* Effect.forEach(yield* readLaunches(env.stateDir, run.id), (launch) =>
    fs.exists(launch.output).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map((done) => ({ launch, done })),
    ),
  );
  const stop = Option.getOrUndefined(
    Arr.findLast(
      yield* readAudit(run.dir).pipe(Effect.orElseSucceed(() => [])),
      (line) => line.operation === "stop",
    ),
  );
  return laneOf({
    run: {
      id: run.id,
      workflow: run.workflow,
      title: runTitle(run),
      state: run.state,
      requestedBy: run.requestedBy ?? null,
      execution: run.engine?.execution ?? executionOfState(run.state),
      note: run.note,
    },
    machine: machineOf(env),
    lines: yield* readStepLines(run.dir),
    steering: yield* readStepSteering(run.dir),
    usual: yield* usualStepTimes(env.stateDir, run.workflow),
    launches,
    questions: run.engine?.questions ?? [],
    verifications: yield* readVerifications(run.evidence).pipe(Effect.orElseSucceed(() => [])),
    ...context,
    wakes: run.engine?.wakes ?? null,
    stoppedBy: run.state === "stopped" && stop !== undefined ? whoActed(stop.actor) : null,
    now: yield* Clock.currentTimeMillis,
  });
});

/** The Step of a Run that started a child, from the Run's own records. */
const startedIn = Effect.fn("Flow.startedIn")(function* (parent: RunFacts, child: string) {
  const lines = yield* readStepLines(parent.dir);
  const started = Option.getOrUndefined(
    Arr.findLast(lines, (line) => line.kind === "child" && line.run === child),
  );
  if (started?.kind !== "child") return null;
  const key = started.key;
  for (const line of lines) if (line.kind === "enter" && line.key === key) return line.step.id;
  return null;
});

/** What a Task knows that its Flow is drawn from, beside each Run's own records. */
export interface TaskFacts {
  /** The Runs that are its rows: every Run of the Task but its Repo runs. */
  readonly rows: ReadonlyArray<RunFacts>;
  /** Every Run the host knows, for the children a row started outside it. */
  readonly all: ReadonlyArray<RunFacts>;
  /** A fan-out's Repo runs by their parent, and each repository's Wave. */
  readonly repoRunsOf: ReadonlyMap<string, ReadonlyArray<RunFacts>>;
  readonly waves: ReadonlyArray<{
    readonly parent: string;
    readonly repo: string;
    readonly wave: number;
    readonly run: string | null;
  }>;
  readonly leader: RunFacts;
  /** Whether the Task's work has settled, so nothing is current. */
  readonly settled: boolean;
  readonly waitOf: (run: RunFacts) => LaneWait | null;
  readonly offer: { readonly id: string; readonly title: string } | null;
  readonly mr: string | null;
  /** The Run whose merge request the Task's is. */
  readonly merging: string;
  readonly mrState: MrState | null;
  readonly mrStates: ReadonlyMap<string, MrState>;
  readonly ci: Parameters<typeof releaseRow>[0]["ci"];
  /** Ready to release's first missing fact, or its word that it is ready, while the MR is open. */
  readonly readiness: string | null;
  readonly mrOf: (run: RunFacts) => string | null;
  readonly mrLabel: (mr: string) => string;
}

/** A Task drawn as the work it took (ADR-draft-a-step-is-declared-where-its-work-is-written D3, D5). */
export const taskFlowFor = Effect.fn("Flow.task")(function* (env: PluginEnv, task: TaskFacts) {
  const rows = [...task.rows].sort((one, other) =>
    pipe_(one.created, Str.localeCompare(other.created)),
  );
  const inTask = new Set(Arr.map(rows, (run) => run.id));
  const machine = machineOf(env);
  const fs = yield* FileSystem.FileSystem;
  const installation = Str.trim(
    yield* fs.readFileString(`${env.stateDir}/installation`).pipe(Effect.orElseSucceed(() => "")),
  );

  const linkOf = Effect.fn("Flow.link")(function* (child: RunFacts) {
    const lane = yield* laneFor(env, child);
    const at = currentOf(lane);
    const mr = task.mrOf(child);
    return {
      run: child.id,
      machine,
      canResume:
        child.engine?.execution !== "failed" &&
        child.engine?.execution !== "completed" &&
        (child.state === "stopped" || child.parked !== null || child.undriven),
      state: linkState(child.state),
      said: linkSaid({
        state: child.state,
        created: child.created,
        finished: child.finished,
        note: child.note,
        mr,
        mrState: mr === null ? null : (task.mrStates.get(task.mrLabel(mr)) ?? null),
        current:
          at === null
            ? null
            : (Option.getOrUndefined(Arr.findFirst(lane.nodes, (node) => node.id === at.node))
                ?.said ?? null),
      }),
    };
  });

  const lanes: FlowLane[] = [];
  for (const run of rows) {
    const repos = task.repoRunsOf.get(run.id) ?? [];
    const own = Arr.filter(
      task.all,
      (one) => one.parent === run.id && !inTask.has(one.id) && !repos.includes(one),
    );
    const children: ChildFact[] = [];
    for (const child of own)
      children.push({
        id: child.id,
        title: pipe_(child.id, Str.startsWith(`${run.id}.`))
          ? pipe_(child.id, Str.slice(run.id.length + 1))
          : child.id,
        created: child.created,
        link: yield* linkOf(child),
        wave: null,
      });
    const waves = Arr.filter(task.waves, (one) => one.parent === run.id);
    const planned = (repo: RunFacts) => {
      const at = Option.getOrElse(
        Arr.findFirstIndex(waves, (one) => one.run === repo.id),
        () => -1,
      );
      return at === -1 ? waves.length : at;
    };
    for (const repo of [...repos].sort((one, other) => planned(one) - planned(other)))
      children.push({
        id: repo.id,
        title: repo.repo ?? repo.id,
        created: repo.created,
        link: yield* linkOf(repo),
        wave: Option.getOrUndefined(Arr.findFirst(waves, (one) => one.run === repo.id))?.wave ?? 1,
      });
    const lane = yield* laneFor(env, run, {
      children,
      toCome: Arr.filter(waves, (one) => one.run === null),
      wait: task.waitOf(run),
      offer: run.id === task.leader.id ? task.offer : null,
      readiness: run.id === task.merging ? task.readiness : null,
    });
    const links = Arr.map(yield* readRunLinks(run.dir), (one) => ({
      step: one.step,
      node: requestedLink(one),
    }));
    const requested = Arr.filter(
      task.all,
      (one) =>
        !inTask.has(one.id) &&
        one.requestedBy?.run === run.id &&
        one.requestedBy.machine.installation === installation,
    );
    if (requested.length > 0) {
      const launches = yield* readLaunches(env.stateDir, run.id);
      for (const child of requested) {
        const launch = Option.getOrUndefined(
          Arr.findLast(
            launches,
            (one) =>
              one.agent === child.requestedBy?.agent &&
              (one.at === undefined || one.at <= epochMs(child.created)),
          ),
        );
        const link = yield* linkOf(child);
        links.push({
          step: launch?.step?.step ?? null,
          node: requestedLink({
            run: child.id,
            workflow: child.workflow,
            machine: { installation, name: machine },
            state: link.state,
            said: link.said,
            at: null,
            canResume: link.canResume,
          }),
        });
      }
    }
    const nodes: FlowNode[] = Arr.map(lane.nodes, (node) => {
      const own = Arr.filter(links, (one) => one.step === node.id);
      const mr = mrRefOf(task.mrOf(run) ?? task.mr);
      return {
        ...node,
        links: own.length === 0 ? node.links : Arr.map(own, (one) => one.node),
        url:
          node.produces === "merge-request" && mr !== null ? (mrUrlOf(mr) ?? undefined) : node.url,
      };
    });
    for (const link of Arr.filter(links, (one) => !Arr.some(nodes, (node) => node.id === one.step)))
      nodes.push({ ...link.node, offPath: true, runs: [] });
    const linked = { ...lane, nodes };
    const parent =
      run.parent === null
        ? undefined
        : Option.getOrUndefined(Arr.findFirst(rows, (one) => one.id === run.parent));
    lanes.push(
      parent === undefined
        ? linked
        : { ...linked, startedBy: { run: parent.id, step: yield* startedIn(parent, run.id) } },
    );
  }
  const leading = Option.getOrUndefined(
    Arr.findFirst(lanes, (lane) => lane.run === task.leader.id),
  );
  const flow: Flow = {
    lanes,
    current: task.settled || leading === undefined ? null : currentOf(leading),
    release:
      task.mr === null
        ? null
        : releaseRow({
            mrState: task.mrState,
            ci: task.ci,
            mrUrl: mrRefOf(task.mr) === null ? null : mrUrlOf(mrRefOf(task.mr)!),
          }),
  } satisfies Flow;
  return { ...flow, notice: flowNotice(flow, yield* Clock.currentTimeMillis) };
});
