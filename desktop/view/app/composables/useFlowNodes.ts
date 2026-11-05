// What FlowMap draws of each node and lane, read once per change of what it is read from
// rather than on every render, and kept as it was where it is unchanged: a 300-node Flow
// renders again for each focus and selection, and is sent again whole for each change.

import { computed } from "vue";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import type { Flow, FlowRun } from "../../../../src/board-model";
import { keepRecord } from "../../../src/shared/keep-equal";
import { stepSteering } from "../../../src/shared/step-steering";
import {
  desktopFlowAction,
  desktopLaneAction,
  type FlowActionView,
} from "../../../src/shared/flow-actions";
import {
  cardForLink,
  flowRows,
  inspectorOf,
  nodeName,
  type FlowCard,
  type FlowSpot,
} from "../../../src/shared/flow";

export interface FlowNodesFrom {
  readonly flow: Flow;
  readonly cards: ReadonlyArray<FlowCard>;
  readonly away: ReadonlySet<string>;
  readonly installation: string;
  readonly live: boolean;
}

export interface NodeView {
  readonly name: string;
  readonly primary: FlowActionView | null;
  readonly menu: ReadonlyArray<FlowActionView>;
  readonly steering: ReturnType<typeof stepSteering>;
}

export const nodeKey = (run: string, node: string) => `${run}\u0000${node}`;

interface FlowNodes {
  readonly nodes: Readonly<Record<string, NodeView>>;
  readonly laneMenus: Readonly<Record<string, ReadonlyArray<FlowActionView>>>;
}

/** What a Step's tooltip says, read for the one Step it shows rather than for every Step. */
export const stepHover = (flow: Flow, spot: FlowSpot, now: number): string => {
  const info = inspectorOf(flow, { ...spot, item: null }, now);
  return info === null
    ? ""
    : Arr.join(
        Arr.filter(
          [info.title, pipe(info.state, Str.replaceAll("-", " ")), info.said, ...info.lines],
          (part): part is string => Boolean(part),
        ),
        "\n",
      );
};

export const useFlowNodes = (from: FlowNodesFrom) => {
  let before: FlowNodes | undefined;
  return computed((): FlowNodes => {
    const { flow, cards, away, installation, live } = from;
    const lanes = new Map(Arr.map(flow.lanes, (lane) => [lane.run, lane] as const));
    const laneOf = (run: string) => lanes.get(run) ?? flow.lanes.at(-1);
    const nodes: Record<string, NodeView> = {};
    const laneMenus: Record<string, ReadonlyArray<FlowActionView>> = {};
    for (const row of flowRows(flow)) {
      const lane = lanes.get(row.run);
      laneMenus[row.run] =
        lane === undefined
          ? []
          : Arr.flatMap(lane.actions ?? [], (kind) => {
              const one = desktopLaneAction(kind, lane, installation, live);
              return one === null ? [] : [one];
            });
      const owner = laneOf(row.run);
      for (const node of row.nodes) {
        const actionOf = (kind: NonNullable<FlowRun["primary"]>) =>
          owner === undefined ? null : desktopFlowAction(kind, node, owner, installation, live);
        const primary = node.primary == null ? null : actionOf(node.primary);
        const steering = stepSteering(node);
        nodes[nodeKey(row.run, node.id)] = {
          primary,
          steering,
          menu: Arr.flatMap([node.primary, ...(node.actions ?? [])], (kind) => {
            const one = kind == null ? null : actionOf(kind);
            return one === null ? [] : [one];
          }),
          name: Arr.join(
            Arr.filter(
              [
                nodeName(node, {
                  missing: node.link !== undefined && cardForLink(node, cards) === undefined,
                  notLive: Option.exists(
                    Option.fromNullishOr(node.link),
                    ({ machine }) => machine != null && away.has(machine),
                  ),
                  action: primary?.label,
                }),
                steering.pause,
                steering.badge,
              ],
              (part): part is string => Boolean(part),
            ),
            ". ",
          ),
        };
      }
    }
    const kept = {
      nodes: keepRecord(nodes, before?.nodes),
      laneMenus: keepRecord(laneMenus, before?.laneMenus),
    };
    return (before =
      before !== undefined && kept.nodes === before.nodes && kept.laneMenus === before.laneMenus
        ? before
        : kept);
  });
};
