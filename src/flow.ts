// A Run drawn as the Steps it took, built from what it recorded and what its module
// declares (ADR-draft-a-step-is-declared-where-its-work-is-written D3–D6). Pure, so every
// door that reads a Flow reads one set of rules.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import { DateTime } from "effect";
import { CommandLine } from "effect/process";
import {
  mrLabel,
  ranOn,
  type Flow,
  type FlowStrip,
  type ForgeChecks,
  type MrState,
  type FlowLink,
  type FlowWait,
  type FlowAttempt,
  type FlowLane,
  type FlowNode,
  type FlowQuestion,
  type FlowRun,
  type FlowState,
  type RequestedBy,
  type RunAgent,
} from "./board-model";
import type { Launched } from "./launches";
import type { RunState } from "./runs";
import type { StepLine, StepMeta, StepPlace } from "./steps";
import type { Verification } from "./verify-model";
import { clockTime, epochMs, minutes } from "./time";
import { stepElapsed } from "./flow-timing";
import type { readStepSteering } from "./step-steering";
import type { Effect } from "effect";

export type Execution = FlowLane["execution"];

/** A question the Run asked, as the engine stored it. */
export interface AskedFact {
  readonly name: string;
  readonly asked: string | null;
  readonly answered: string | null;
  readonly by: string | null;
  readonly open: boolean;
  readonly text?: string;
  readonly options?: FlowQuestion["options"];
}

/** Everything one Run's row is built from. */
export interface LaneFacts {
  readonly usual?: ReadonlyMap<string, number>;
  readonly steering?: Effect.Success<ReturnType<typeof readStepSteering>>;
  readonly verifications?: ReadonlyArray<Verification>;
  readonly run: {
    readonly id: string;
    readonly workflow: string;
    readonly title: string;
    readonly state: RunState;
    readonly requestedBy: RequestedBy | null;
    readonly execution: Execution;
    /** Why it stopped going, where it failed. */
    readonly note: string | null;
  };
  readonly machine: string;
  readonly lines: ReadonlyArray<StepLine>;
  /** Its launches in order, each with whether its Output is in. */
  readonly launches: ReadonlyArray<{ readonly launch: Launched; readonly done: boolean }>;
  readonly questions: ReadonlyArray<AskedFact>;
  /** Runs it started that are not rows of its Task: a Task's own, or its Repo runs. */
  readonly children: ReadonlyArray<ChildFact>;
  /** The repositories of Waves its fan-out has not started yet. */
  readonly toCome: ReadonlyArray<{ readonly repo: string; readonly wave: number }>;
  /** What holds it up, in its card's words, other than a question or a timer. */
  readonly wait: LaneWait | null;
  /** The offer a finished leading Run makes, which ends its row. */
  readonly offer: { readonly id: string; readonly title: string } | null;
  /** What Ready to release says while its merge request is open, for the Step that made it. */
  readonly readiness: string | null;
  /** When a durable timer wakes it, where it sleeps on one. */
  readonly wakes: string | null;
  /** Who stopped it, where it was stopped. */
  readonly stoppedBy: string | null;
  readonly now: number;
}

/** A Run this one started that is drawn as a link: titled by its invocation, or its repository. */
export interface ChildFact {
  readonly id: string;
  readonly title: string;
  readonly created: string;
  readonly link: FlowLink;
  /** Its repository's Wave, for a Repo run. */
  readonly wave: number | null;
}

/** A wait as the card says it; the lane puts it on the Step it holds up. */
export interface LaneWait {
  readonly wait: FlowWait;
  /** Whether it is on the human: a proposal, or a pane that waits. */
  readonly needsYou: boolean;
  readonly said: string;
}

/** One call of a Step, as its records say. */
interface StepRun {
  readonly key: string;
  readonly meta: StepMeta;
  readonly place: StepPlace | null;
  readonly entered: string;
  readonly log: number | null;
  left: string | null;
  failed: { readonly at: string; readonly why: string } | null;
  attempts: FlowAttempt[];
}

const going = (state: RunState) => state === "running" || state === "waiting";

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const firstLine = (text: string) =>
  Option.getOrUndefined(
    Option.map(Option.fromNullishOr(Str.split(text, "\n")[0]), (present_____) =>
      Str.trim(present_____),
    ),
  ) ?? "";

const agentOf = (launch: Launched): RunAgent => ({
  operation: launch.operation,
  agent: launch.agent,
  harness: launch.harness,
  model: launch.model ?? null,
  effort: launch.effort ?? null,
  from: launch.from ?? null,
  why: launch.why ?? null,
  at: launch.at === undefined ? null : isoOf(launch.at),
});

const AGENT_QUESTION = /^ask-(.+)-\d+$/;

/** The operation whose agent asked this question on its Run, where an agent did. */
const askerOf = (name: string) => AGENT_QUESTION.exec(name)?.[1] ?? null;

const placeSaid = (place: StepPlace | null) =>
  place === null ? null : "item" in place ? place.item : `Round ${place.round}`;

const flowQuestion = (one: AskedFact): FlowQuestion => ({
  id: one.name,
  open: one.open,
  text: one.text,
  options: one.options,
  name: one.name,
  asked: one.asked,
  answered: one.answered,
  by: one.by,
});

/** One Run's row of Steps. */
export function laneOf(facts: LaneFacts): FlowLane {
  const { run, now } = facts;
  const ended = !going(run.state);
  const forecasts: Array<{ readonly at: string; readonly steps: ReadonlyArray<StepMeta> }> = [];
  const runs = new Map<string, StepRun>();
  const entries: Array<{ readonly at: string; readonly cause: "restarted" | "resumed" }> = [];
  const questionIn = new Map<string, string>();
  const childIn = new Map<string, string>();
  for (const line of facts.lines) {
    switch (line.kind) {
      case "forecast":
        forecasts.push({ at: line.at, steps: line.steps });
        break;
      case "enter":
        if (!runs.has(line.key))
          runs.set(line.key, {
            key: line.key,
            meta: line.step,
            place: line.place,
            entered: line.at,
            log: line.log ?? null,
            left: null,
            failed: null,
            attempts: [{ at: line.at, cause: null }],
          });
        break;
      case "leave": {
        const one = runs.get(line.key);
        if (one !== undefined && one.left === null) one.left = line.at;
        break;
      }
      case "fail": {
        const one = runs.get(line.key);
        if (one !== undefined) one.failed = { at: line.at, why: line.why };
        break;
      }
      case "entry":
        if (line.cause !== null) entries.push({ at: line.at, cause: line.cause });
        break;
      case "question":
        questionIn.set(line.name, line.key);
        break;
      case "child":
        childIn.set(line.run, line.key);
        break;
      case "check":
        break;
    }
  }
  // An entry that went on with a Step run left part-done is another attempt at it.
  for (const one of runs.values())
    for (const entry of entries)
      if (entry.at > one.entered && (one.left === null || entry.at < one.left))
        one.attempts.push({ at: entry.at, cause: entry.cause });

  const declared = forecasts.length > 0 || runs.size > 0;
  // A launch from before its Run recorded Steps names no Step: it is the Step its Run
  // replayed under the same key.
  const stepKeyOf = (launch: Launched) =>
    launch.step?.key ?? (runs.has(launch.operation) ? launch.operation : undefined);
  const keyOfLaunch = new Map<string, string>();
  for (const { launch } of facts.launches) {
    const key = stepKeyOf(launch);
    if (key !== undefined) keyOfLaunch.set(launch.operation, key);
  }
  const questionKey = (name: string) => {
    const asker = askerOf(name);
    return questionIn.get(name) ?? (asker === null ? undefined : keyOfLaunch.get(asker));
  };

  const ranOnFor = (key: string) => {
    const last = Option.getOrUndefined(
      Arr.findLast(facts.launches, ({ launch }) => stepKeyOf(launch) === key),
    );
    return last === undefined ? null : ranOn(agentOf(last.launch));
  };
  const agentFor = (key: string) =>
    Option.getOrUndefined(Arr.findLast(facts.launches, ({ launch }) => stepKeyOf(launch) === key))
      ?.launch.agent ?? null;
  const questionsFor = (key: string) =>
    Arr.filter(facts.questions, (one) => questionKey(one.name) === key);
  const placeKey = (place: StepPlace | null | undefined) =>
    place == null ? null : "item" in place ? place.item : `Round ${place.round}`;
  const proofsFor = (one: StepRun) =>
    Arr.filter(
      facts.verifications ?? [],
      (proof) =>
        proof.step === one.meta.id &&
        placeKey(proof.place) === placeKey(one.place) &&
        proof.at >= one.entered &&
        (one.left === null || proof.at <= one.left),
    );
  const whyFor = (state: FlowState, one: StepRun) => {
    if (state !== "failed") return null;
    const last = Option.getOrUndefined(
      Arr.findLast(proofsFor(one), (proof) => proof.at >= one.attempts.at(-1)!.at),
    );
    if (last?.result === "fail") {
      const command = CommandLine.display([last.executable, ...last.argv]);
      const output = Str.split(
        Arr.join(
          Arr.filter([Str.trimEnd(last.tail.stdout), Str.trimEnd(last.tail.stderr)], Boolean),
          "\n",
        ),
        "\n",
      );
      return Arr.join([command, ...output.slice(-19)], "\n");
    }
    return Arr.join(Str.split(one.failed?.why ?? run.note ?? "Failed", "\n").slice(0, 20), "\n");
  };

  const stateOfRun = (one: StepRun): FlowState => {
    if (one.left !== null) return "done";
    const retried = one.attempts.at(-1)!.at;
    if (one.failed !== null && one.failed.at >= retried) return "failed";
    if (run.state === "stopped") return "stopped";
    if (run.state === "failed") return "failed";
    if (run.state === "succeeded") return "done";
    if (Arr.some(questionsFor(one.key), (asked) => asked.open)) return "needs-you";
    if (facts.wakes !== null) return "waiting";
    return "running";
  };

  const factOf = (state: FlowState, one: StepRun, said: string | null): string | null => {
    switch (state) {
      case "done":
        return one.left === null ? "Done" : minutes(epochMs(one.left) - epochMs(one.entered));
      case "running":
        return said ?? minutes(now - epochMs(one.attempts.at(-1)!.at));
      case "needs-you": {
        const asked = Option.getOrUndefined(
          Arr.findFirst(questionsFor(one.key), (question) => question.open),
        )?.asked;
        return asked == null ? "Asked" : `Asked ${minutes(now - epochMs(asked))} ago`;
      }
      case "waiting":
        return facts.wakes === null ? null : `Wakes at ${clockTime(epochMs(facts.wakes))}`;
      case "failed":
        return firstLine(one.failed?.why ?? run.note ?? "") || "Failed";
      case "stopped":
        return facts.stoppedBy === null ? "Stopped" : `Stopped by ${facts.stoppedBy}`;
      case "not-run":
        return "Not run";
      case "expected":
        return null;
    }
  };

  const withAttempts = (said: string | null, attempts: number) =>
    said !== null && attempts > 1 ? `${said} · ${ordinal(attempts)} attempt` : said;

  const runNode = (one: StepRun, offPath: boolean): FlowRun => {
    const state = stateOfRun(one);
    return {
      id: one.key,
      title: placeSaid(one.place) ?? one.meta.title,
      kind: one.meta.kind,
      description: one.meta.description,
      role: one.meta.role,
      declared: true,
      state,
      said: withAttempts(factOf(state, one, null), one.attempts.length),
      wait: state === "waiting" ? "timer" : null,
      produces: one.meta.produces,
      offPath,
      place: placeSaid(one.place),
      started: one.entered,
      ended: one.left,
      attempts: one.attempts,
      ranOn: ranOnFor(one.key),
      agent: agentFor(one.key),
      questions: Arr.map(questionsFor(one.key), flowQuestion),
      log: one.log,
      why: whyFor(state, one),
      evidence: proofsFor(one).length,
      link: Option.getOrUndefined(
        Arr.findFirst(
          facts.children,
          (child) => childIn.get(child.id) === one.key && child.wave === null,
        ),
      )?.link,
    };
  };

  /** A Step none of whose runs is known yet, or one the Run ended without. */
  const unreached = (meta: StepMeta, id: string, title: string, place: string | null): FlowRun => {
    const state: FlowState = ended ? "not-run" : "expected";
    return {
      id,
      title,
      kind: meta.kind,
      description: meta.description,
      role: meta.role,
      declared: true,
      state,
      said: state === "not-run" ? "Not run" : null,
      wait: null,
      produces: meta.produces,
      offPath: false,
      place,
      started: null,
      ended: null,
      attempts: [],
      ranOn: null,
      questions: [],
    };
  };

  /** Which forecast was in force at a time: the latest made before it. */
  const forecastAt = (at: string) =>
    Option.getOrUndefined(Arr.findLast(forecasts, (one) => one.at <= at)) ?? null;
  const latest = forecasts.at(-1) ?? null;

  const stepNode = (id: string): FlowNode => {
    const calls = Arr.filter([...runs.values()], (one) => one.meta.id === id);
    const meta = calls.at(-1)!.meta;
    const first = calls[0]!;
    const inForce = forecastAt(first.entered);
    const offPath = inForce !== null && !Arr.some(inForce.steps, (one) => one.id === id);
    const items = Option.getOrUndefined(
      Arr.findLast(calls, (one) => one.place !== null && "item" in one.place),
    )?.place;
    const listed = items !== undefined && items !== null && "items" in items ? items.items : [];
    const called = new Set(
      Arr.map(calls, (one) => (one.place !== null && "item" in one.place ? one.place.item : "")),
    );
    const keys = new Set(Arr.map(calls, (one) => one.key));
    const started = Arr.filter(facts.children, (child) => keys.has(childIn.get(child.id) ?? ""));
    const repos = Arr.filter(started, (child) => child.wave !== null);
    const link = Option.getOrUndefined(Arr.findLast(started, (child) => child.wave === null))?.link;
    const fan =
      repos.length === 0 ? [] : [...Arr.map(repos, linkRun), ...Arr.map(facts.toCome, toComeRun)];
    const made = Arr.map(calls, (one) => runNode(one, offPath));
    const toCome = Arr.map(
      Arr.filter(listed, (item) => !called.has(item)),
      (item) => unreached(meta, `${id}@${item}`, item, item),
    );
    const all = listed.length === 0 ? made : sortedByItems(listed, [...made, ...toCome]);
    const states = Arr.map(made, (one) => one.state);
    const state: FlowState = states.includes("needs-you")
      ? "needs-you"
      : states.includes("running")
        ? "running"
        : states.includes("waiting")
          ? "waiting"
          : states.includes("failed")
            ? "failed"
            : states.includes("stopped")
              ? "stopped"
              : toCome.length > 0 && !ended
                ? "running"
                : "done";
    const current =
      Option.getOrUndefined(Arr.findLast(calls, (one) => stateOfRun(one) === state)) ??
      calls.at(-1)!;
    const position =
      listed.length > 0 && current.place !== null && "item" in current.place
        ? `Slice ${listed.indexOf(current.place.item) + 1} of ${listed.length}`
        : current.place !== null && "round" in current.place
          ? `Round ${current.place.round}`
          : null;
    const plain = factOf(state, current, state === "running" ? position : null);
    const attempts = current.attempts;
    const said = withAttempts(
      calls.length > 1 && state === "done"
        ? minutes(epochMs(calls.at(-1)!.left ?? first.entered) - epochMs(first.entered))
        : plain,
      attempts.length,
    );
    return {
      id,
      title: meta.title,
      kind: meta.kind,
      description: meta.description,
      role: meta.role,
      declared: true,
      state,
      said: offPath && said !== null ? `Off the path · ${said}` : said,
      wait: state === "waiting" ? "timer" : null,
      produces: meta.produces,
      offPath,
      place: null,
      started: first.entered,
      ended: state === "done" ? (calls.at(-1)!.left ?? null) : null,
      attempts,
      ranOn: ranOnFor(current.key),
      agent: agentFor(current.key),
      questions: Arr.map(
        Arr.flatMap(calls, (one) => questionsFor(one.key)),
        flowQuestion,
      ),
      log: current.log,
      why: whyFor(state, current),
      evidence: Arr.filter(facts.verifications ?? [], (proof) => proof.step === id).length,
      runs: fan.length > 0 ? fan : calls.length > 1 || listed.length > 0 ? all : [],
      link: calls.length === 1 && listed.length === 0 ? link : undefined,
    };
  };

  // What happened, in the order it began: each Step by its first call, and work no Step
  // declared by when it was started.
  const happened: Array<{ readonly at: string; readonly node: FlowNode }> = [];
  const seen = new Set<string>();
  for (const one of runs.values()) {
    if (seen.has(one.meta.id)) continue;
    seen.add(one.meta.id);
    happened.push({ at: one.entered, node: stepNode(one.meta.id) });
  }
  for (const node of undeclaredNodes(facts, keyOfLaunch, questionKey, childIn, ended))
    happened.push(node);
  happened.sort((one, other) => pipe(one.at, Str.localeCompare(other.at)));
  const nodes = inPathOrder(
    Arr.map(happened, (one) => one.node),
    Arr.map(
      latest?.steps ?? [],
      (meta) =>
        Option.getOrUndefined(
          Arr.findFirst(happened, (one) => one.node.declared && one.node.id === meta.id),
        )?.node ?? {
          ...unreached(meta, meta.id, meta.title, null),
          runs: [],
        },
    ),
  );
  withWait(nodes, facts.wait);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const usual = facts.usual?.get(node.id) ?? null;
    const timing = (one: FlowRun) => {
      const long = one.state === "running" && usual !== null && stepElapsed(one, now) > usual * 2;
      return { ...one, usual, long, said: long ? "Longer than usual" : one.said };
    };
    const pause =
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(facts.steering), (present) =>
          Option.getOrUndefined(Arr.findFirst(present.pauses, (one) => one.step === node.id)),
        ),
      ) ?? null;
    const reached = facts.steering?.reached;
    nodes[i] = {
      ...timing(node),
      runs: Arr.map(node.runs, timing),
      pause,
      notes:
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(facts.steering), (present_) =>
            Arr.filter(present_.notes, (one) => one.step === node.id),
          ),
        ) ?? [],
      said:
        reached?.step === node.id && node.wait === "hold"
          ? `Paused here, as ${reached.by} asked`
          : pause !== null && node.state === "expected"
            ? "Pauses before it"
            : timing(node).said,
    };
  }
  withReadiness(nodes, facts.readiness);
  if (facts.offer !== null) nodes.push(offerNode(facts.offer));

  return {
    run: run.id,
    workflow: run.workflow,
    title: run.title,
    machine: facts.machine,
    requestedBy: run.requestedBy,
    execution: run.execution,
    declared,
    nodes,
  };
}

export const flowNotice = (flow: Flow, now: number): string | null => {
  const node = Option.getOrUndefined(
    Option.map(
      Option.fromNullishOr(
        Option.getOrUndefined(
          Arr.findFirst(
            flow.lanes,
            (one) =>
              one.run ===
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(flow.current), (present__) => present__.run),
              ),
          ),
        ),
      ),
      (present___) =>
        Option.getOrUndefined(
          Arr.findFirst(
            present___.nodes,
            (one) =>
              one.id ===
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(flow.current), (present____) => present____.node),
              ),
          ),
        ),
    ),
  );
  return node?.long === true && node.usual != null
    ? `${node.title} is taking longer than usual: ${minutes(stepElapsed(node, now))}, usually ${pipe(minutes(node.usual), Str.replace(/ min$/, ""))}.`
    : null;
};

/**
 * The path's nodes in its order, and each node off it after the one that happened before it:
 * `happened` is every node that ran, oldest first, and `path` the forecast's.
 */
function inPathOrder(happened: ReadonlyArray<FlowNode>, path: ReadonlyArray<FlowNode>): FlowNode[] {
  if (path.length === 0) return [...happened];
  const ordered = [...path];
  Arr.forEach(happened, (node, at) => {
    if (ordered.includes(node)) return;
    const before = happened[at - 1];
    ordered.splice(before === undefined ? 0 : ordered.indexOf(before) + 1, 0, node);
  });
  return ordered;
}

const sortedByItems = (items: ReadonlyArray<string>, runs: ReadonlyArray<FlowRun>) =>
  [...runs].sort((one, other) => items.indexOf(one.place ?? "") - items.indexOf(other.place ?? ""));

/** Work no Step declared: Operations, questions and children, as they happened. */
function undeclaredNodes(
  facts: LaneFacts,
  keyOfLaunch: ReadonlyMap<string, string>,
  questionKey: (name: string) => string | undefined,
  childIn: ReadonlyMap<string, string>,
  ended: boolean,
): ReadonlyArray<{ readonly at: string; readonly node: FlowNode }> {
  const { run, now } = facts;
  const base = {
    description: "",
    role: null,
    declared: false,
    wait: null,
    produces: null,
    offPath: false,
    place: null,
    ended: null,
    attempts: [],
    runs: [],
  } as const;
  const nodes: Array<{ readonly at: string; readonly node: FlowNode }> = [];
  const operations = new Map<
    string,
    Array<{ readonly launch: Launched; readonly done: boolean }>
  >();
  for (const one of facts.launches) {
    if (one.launch.step !== undefined || keyOfLaunch.has(one.launch.operation)) continue;
    operations.set(one.launch.operation, [...(operations.get(one.launch.operation) ?? []), one]);
  }
  for (const [operation, launches] of operations) {
    const last = launches.at(-1)!;
    const at = launches[0]!.launch.at;
    const started = at === undefined ? null : isoOf(at);
    const asked = Arr.filter(facts.questions, (one) => askerOf(one.name) === operation);
    const state: FlowState = last.done
      ? "done"
      : Arr.some(asked, (one) => one.open)
        ? "needs-you"
        : run.state === "stopped"
          ? "stopped"
          : run.state === "failed"
            ? "failed"
            : ended
              ? "done"
              : "running";
    nodes.push({
      at: started ?? "",
      node: {
        ...base,
        id: operation,
        title: operation,
        kind: "agent",
        state,
        said: undeclaredSaid(state, started, asked, facts, now),
        started,
        ranOn: ranOn(agentOf(last.launch)),
        agent: last.launch.agent,
        questions: Arr.map(asked, flowQuestion),
      },
    });
  }
  for (const one of facts.questions) {
    if (askerOf(one.name) !== null || questionKey(one.name) !== undefined) continue;
    const state: FlowState = one.open ? "needs-you" : "done";
    nodes.push({
      at: one.asked ?? "",
      node: {
        ...base,
        id: one.name,
        title: one.name,
        kind: "question",
        state,
        said: undeclaredSaid(state, one.asked, [one], facts, now),
        started: one.asked,
        ranOn: null,
        questions: [flowQuestion(one)],
      },
    });
  }
  const loose = Arr.filter(facts.children, (child) => !childIn.has(child.id));
  for (const child of Arr.filter(loose, (one) => one.wave === null))
    nodes.push({
      at: child.created,
      node: {
        ...base,
        id: child.id,
        title: child.title,
        kind: "link",
        state: child.link.state,
        said: child.link.said,
        started: child.created,
        ranOn: null,
        questions: [],
        link: child.link,
      },
    });
  const repos = Arr.filter(loose, (one) => one.wave !== null);
  if (repos.length > 0) {
    const runs = [...Arr.map(repos, linkRun), ...Arr.map(facts.toCome, toComeRun)];
    nodes.push({
      at: repos[0]!.created,
      node: {
        ...base,
        id: "repo-runs",
        title: "Repo runs",
        kind: "workflow",
        state: fanState(runs, ended),
        said: null,
        started: repos[0]!.created,
        ranOn: null,
        questions: [],
        runs,
      },
    });
  }
  return nodes;
}

const linkRun = (child: ChildFact): FlowRun => ({
  id: child.id,
  title: child.title,
  kind: "link",
  description: "",
  role: null,
  declared: false,
  state: child.link.state,
  said: child.link.said,
  wait: null,
  produces: null,
  offPath: false,
  place: null,
  started: child.created,
  ended: null,
  attempts: [],
  ranOn: null,
  questions: [],
  wave: child.wave ?? undefined,
  link: child.link,
});

const toComeRun = (repo: { readonly repo: string; readonly wave: number }): FlowRun => ({
  id: `repo:${repo.repo}`,
  title: repo.repo,
  kind: "link",
  description: "",
  role: null,
  declared: false,
  state: "expected",
  said: null,
  wait: null,
  produces: null,
  offPath: false,
  place: null,
  started: null,
  ended: null,
  attempts: [],
  ranOn: null,
  questions: [],
  wave: repo.wave,
  link: { run: null, machine: null, state: "expected", said: null },
});

const fanState = (runs: ReadonlyArray<FlowRun>, ended: boolean): FlowState => {
  const states = Arr.map(runs, (one) => one.state);
  for (const state of ["needs-you", "running", "waiting", "failed", "stopped"] as const)
    if (states.includes(state)) return state;
  return states.includes("expected") && !ended ? "running" : "done";
};

/** Where a wait sits: the Step going, else the next the path expects, else the last that ran. */
const heldUp = (nodes: ReadonlyArray<FlowNode>): number => {
  const going = Option.getOrElse(
    Arr.findLastIndex(
      nodes,
      (node) => node.state === "running" || node.state === "needs-you" || node.state === "waiting",
    ),
    () => -1,
  );
  if (going >= 0) return going;
  const next = Option.getOrElse(
    Arr.findFirstIndex(nodes, (node) => node.state === "expected"),
    () => -1,
  );
  if (next >= 0) return next;
  return Option.getOrElse(
    Arr.findLastIndex(nodes, (node) => node.started !== null),
    () => -1,
  );
};

function withWait(nodes: FlowNode[], wait: LaneWait | null) {
  if (wait === null) return;
  const at = heldUp(nodes);
  const node = nodes[at];
  // A question open on it is already what it waits on.
  if (node === undefined || (node.state === "needs-you" && node.wait === null)) return;
  // A Step that failed already says why its Run parked.
  if (wait.wait === "parked" && Arr.some(nodes, (one) => one.state === "failed")) return;
  nodes[at] = {
    ...node,
    state: wait.needsYou ? "needs-you" : "waiting",
    wait: wait.wait,
    said: wait.said,
  };
}

function withReadiness(nodes: FlowNode[], readiness: string | null) {
  if (readiness === null) return;
  const at = Option.getOrElse(
    Arr.findLastIndex(nodes, (node) => node.produces === "merge-request" && node.state === "done"),
    () => -1,
  );
  if (at >= 0) nodes[at] = { ...nodes[at]!, said: readiness };
}

const offerNode = (offer: { readonly id: string; readonly title: string }): FlowNode => ({
  id: `offer:${offer.id}`,
  title: offer.title,
  kind: "offer",
  description: "",
  role: null,
  declared: false,
  state: "expected",
  said: "Offered",
  wait: null,
  produces: null,
  offPath: false,
  place: null,
  started: null,
  ended: null,
  attempts: [],
  ranOn: null,
  questions: [],
  runs: [],
});

function undeclaredSaid(
  state: FlowState,
  started: string | null,
  asked: ReadonlyArray<AskedFact>,
  facts: LaneFacts,
  now: number,
): string | null {
  switch (state) {
    case "done":
      return "Done";
    case "running":
      return started === null ? null : minutes(now - epochMs(started));
    case "needs-you": {
      const open = Option.getOrUndefined(Arr.findFirst(asked, (one) => one.open))?.asked;
      return open == null ? "Asked" : `Asked ${minutes(now - epochMs(open))} ago`;
    }
    case "failed":
      return firstLine(facts.run.note ?? "") || "Failed";
    case "stopped":
      return facts.stoppedBy === null ? "Stopped" : `Stopped by ${facts.stoppedBy}`;
    default:
      return null;
  }
}

/** Where the work is: the last node of a Run still going that is not done or to come. */
export function currentOf(lane: FlowLane): { readonly run: string; readonly node: string } | null {
  if (lane.execution !== "running" && lane.execution !== "suspended") return null;
  const at = Option.getOrUndefined(
    Arr.findLast(
      lane.nodes,
      (node) =>
        node.state === "running" ||
        node.state === "needs-you" ||
        node.state === "waiting" ||
        node.state === "failed",
    ),
  );
  return at === undefined ? null : { run: lane.run, node: at.id };
}

/** What a Run waits on for usage: whose Subscription, and when it resets. */
export interface UsageWait {
  readonly account: string;
  readonly resetsAt: string | null;
}

/** The facts a Run's wait is said from, which are the ones its card says. */
export interface WaitFacts {
  readonly proposals: number;
  readonly blocked: boolean;
  readonly parked: { readonly reason: string | null } | null;
  readonly heldBy: string | null;
  readonly memory: boolean;
  readonly usage: UsageWait | null;
  readonly check: {
    readonly name: string;
    readonly elapsedMs: number | null;
    readonly usualMs: number | null;
  } | null;
  readonly awaiting: boolean;
  readonly machine: string;
  /** Whether it sleeps on a durable timer or on a child still going, which a park is not. */
  readonly sleeping: boolean;
}

const PANE = "Waiting for you in its pane";

/** The one wait that holds a Run up, other than a question or a timer, in its card's words. */
export function laneWaitOf(facts: WaitFacts): LaneWait | null {
  if (facts.proposals > 0)
    return { wait: "proposal", needsYou: true, said: "Collie proposes a correction" };
  if (facts.blocked) return { wait: "stalled", needsYou: true, said: PANE };
  if (facts.heldBy !== null)
    return { wait: "hold", needsYou: false, said: `Held by ${facts.heldBy}` };
  if (facts.memory)
    return { wait: "memory", needsYou: false, said: `${facts.machine} is short of memory` };
  if (facts.usage !== null)
    return {
      wait: "usage",
      needsYou: false,
      said:
        facts.usage.resetsAt === null
          ? `${facts.usage.account}'s usage ran out`
          : `${facts.usage.account}'s session resets ${clockTime(epochMs(facts.usage.resetsAt))}`,
    };
  if (facts.check !== null) {
    const { name, elapsedMs, usualMs } = facts.check;
    const elapsed = elapsedMs === null ? "" : ` · ${minutes(elapsedMs)}`;
    const usual = usualMs === null || elapsedMs === null ? "" : `, usually ${minutes(usualMs)}`;
    return { wait: "check", needsYou: false, said: `${name}${elapsed}${usual}` };
  }
  if (facts.awaiting) return { wait: "ci", needsYou: false, said: "Still running" };
  if (facts.parked !== null && !facts.sleeping)
    return { wait: "parked", needsYou: true, said: facts.parked.reason ?? PANE };
  return null;
}

/** `!12` of a merge request's label, or the label where it has no number. */
const mrNumber = (mr: string) => {
  const label = mrLabel(mr);
  const at = Math.max(
    Option.getOrElse(pipe(label, Str.lastIndexOf("!")), () => -1),
    Option.getOrElse(pipe(label, Str.lastIndexOf("#")), () => -1),
  );
  return at < 0 ? label : `!${pipe(label, Str.slice(at + 1))}`;
};

/** What a link says of the Run it stands for, by how far that Run has got. */
export function linkSaid(child: {
  readonly state: RunState;
  readonly created: string;
  readonly finished: string | null;
  readonly note: string | null;
  readonly mr: string | null;
  readonly mrState: MrState | null;
  /** Its current node's fact line, while it is going. */
  readonly current: string | null;
}): string | null {
  if (child.mr !== null) return `${mrNumber(child.mr)} ${child.mrState ?? "open"}`;
  if (going(child.state)) return child.current;
  if (child.state === "failed") return firstLine(child.note ?? "") || "Failed";
  if (child.finished === null) return null;
  return minutes(epochMs(child.finished) - epochMs(child.created));
}

export const linkState = (state: RunState): FlowState => {
  switch (state) {
    case "succeeded":
      return "done";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
};

const LANDED: ReadonlySet<MrState> = new Set(["merged", "on-stage", "in-prod"]);

const releaseNode = (
  id: string,
  title: string,
  state: FlowState,
  said: string | null,
  wait: FlowWait | null = null,
): FlowNode => ({
  id,
  title,
  kind: "release",
  description: "",
  role: null,
  declared: false,
  state,
  said,
  wait,
  produces: "merge-request",
  offPath: false,
  place: null,
  started: null,
  ended: null,
  attempts: [],
  ranOn: null,
  questions: [],
  runs: [],
});

/** The merge request's way out: CI, the merge, and the furthest tier the forge says it is live on. */
export function releaseRow(facts: {
  readonly mrState: MrState | null;
  readonly ci: ForgeChecks | null;
  readonly mrUrl?: string | null;
}): ReadonlyArray<FlowNode> {
  const landed = facts.mrState !== null && LANDED.has(facts.mrState);
  const ci = landed
    ? releaseNode("ci", "CI", "done", null)
    : facts.ci?.state === "running"
      ? releaseNode("ci", "CI", "waiting", "Still running", "ci")
      : facts.ci?.state === "passed"
        ? releaseNode("ci", "CI", "done", null)
        : facts.ci?.state === "failed"
          ? releaseNode("ci", "CI", "failed", `${facts.ci.name} failed`)
          : releaseNode("ci", "CI", "expected", null);
  const merged = landed
    ? releaseNode("merged", "Merged", "done", null)
    : facts.mrState === "closed"
      ? releaseNode("merged", "Merged", "stopped", "Closed without merging")
      : releaseNode("merged", "Merged", "expected", null);
  const deployed =
    facts.mrState === "in-prod"
      ? [releaseNode("deployed", "In prod", "done", null)]
      : facts.mrState === "on-stage"
        ? [releaseNode("deployed", "On stage", "done", null)]
        : [];
  return [
    { ...ci, url: facts.ci?.url },
    ...Arr.map([merged, ...deployed], (node) => ({ ...node, url: facts.mrUrl ?? undefined })),
  ];
}

/** The strip a card draws: the leading Run's Steps, then the Release row, and where it is. */
export function stripOf(flow: Flow, leader: string): FlowStrip {
  const lane = Option.getOrUndefined(Arr.findFirst(flow.lanes, (one) => one.run === leader));
  const release = flow.release ?? [];
  const at =
    flow.current === null
      ? undefined
      : Option.getOrUndefined(
          Arr.findFirst(
            [
              ...Arr.flatMap(flow.lanes, (one) => (one.run === flow.current!.run ? one.nodes : [])),
              ...release,
            ],
            (node) => node.id === flow.current!.node,
          ),
        );
  return {
    glyphs: Arr.map([...(lane?.nodes ?? []), ...release], (node) => ({
      title: node.title,
      state: node.state,
    })),
    release: release.length,
    current: at === undefined ? null : { title: at.title, said: at.said },
  };
}
