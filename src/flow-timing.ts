import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import type { Flow, FlowClock, FlowLink, FlowNode, FlowRun } from "./board-model";
import { epochMs, minutes } from "./time";

export const stepElapsed = (
  node: FlowRun & { readonly runs?: ReadonlyArray<FlowRun> },
  now: number,
): number => {
  const active =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(node.runs), (present) =>
        Option.getOrUndefined(Arr.findLast(present, (one) => one.state === "running")),
      ),
    ) ?? node;
  return active.started === null ? 0 : Math.max(0, now - epochMs(active.started));
};

export const flowNotice = (flow: Flow, now: number): string | null => {
  const lane = Arr.findFirst(flow.lanes, (one) => one.run === flow.current?.run);
  const node = Option.getOrUndefined(
    Option.flatMap(lane, (present) =>
      Arr.findFirst(present.nodes, (one) => one.id === flow.current?.node),
    ),
  );
  return node?.long === true && node.usual != null
    ? `${node.title} is taking longer than usual: ${minutes(stepElapsed(node, now))}, usually ${pipe(minutes(node.usual), Str.replace(/ min$/, ""))}.`
    : null;
};

const MARK = "";
const MARKED = new RegExp(`${MARK}(-?[\\d.]+)${MARK}`);

/** Minutes since `at` in a fact line while it is built; `settleFlow` turns it into a clock. */
export const since = (at: number) => `${MARK}${at}${MARK}`;

export const saidAt = (clock: FlowClock, now: number) =>
  `${clock.before}${minutes(now - clock.from)}${clock.after}`;

/** A fact line, and the clock it is said from where it counts minutes. */
export interface Said {
  readonly said: string | null;
  readonly clock?: FlowClock;
}

/** A fact line said at `now`, with the clock it is said from where it counts minutes. */
export const settledSaid = (said: string | null, now: number): Said => {
  const found = said === null ? null : MARKED.exec(said);
  if (said === null || found === null) return { said };
  const clock = {
    from: Number(found[1]),
    before: Str.slice(0, found.index)(said),
    after: Str.slice(found.index + found[0].length)(said),
  };
  return { said: saidAt(clock, now), clock };
};

const isRun = (one: Said): one is Said & FlowRun => "state" in one;

const eachSaid = (flow: Flow, run: <A extends Said>(one: A) => A): Flow => {
  const link = (one: FlowLink | undefined) => (one === undefined ? undefined : run(one));
  const ofRun = <A extends FlowRun>(one: A): A => ({ ...run(one), link: link(one.link) });
  const ofNode = (node: FlowNode): FlowNode => ({
    ...ofRun(node),
    runs: Arr.map(node.runs, ofRun),
    links: node.links === undefined ? undefined : Arr.map(node.links, ofRun),
  });
  return {
    ...flow,
    lanes: Arr.map(flow.lanes, (lane) => ({ ...lane, nodes: Arr.map(lane.nodes, ofNode) })),
    release: flow.release === null ? null : Arr.map(flow.release, ofNode),
  };
};

/** The Flow as built, its minutes said at `now` and each one's clock kept beside it. */
export const settleFlow = (flow: Flow, now: number): Flow => {
  const settled = eachSaid(flow, (one) => ({ ...one, ...settledSaid(one.said, now) }));
  return { ...settled, notice: flowNotice(settled, now) };
};

/** The Flow with nothing said that only time moves: a record's, to send once per change. */
export const timeless = (flow: Flow): Flow => ({
  ...eachSaid(flow, (one) => (one.clock === undefined ? one : { ...one, said: null })),
  notice: null,
});

/** The Flow as it reads at `now`: what a front door draws from a timeless one. */
export const timedFlow = (flow: Flow, now: number): Flow => {
  const timed = eachSaid(flow, (one) => {
    const said = one.clock === undefined ? one.said : saidAt(one.clock, now);
    if (!isRun(one) || one.state !== "running" || one.usual == null) return { ...one, said };
    const long = stepElapsed(one, now) > one.usual * 2;
    return { ...one, long, said: long && one.wait !== "hold" ? "Longer than usual" : said };
  });
  return { ...timed, notice: flowNotice(timed, now) };
};
