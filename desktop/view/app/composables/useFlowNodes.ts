// What FlowMap draws of each node and lane, read once per change of what it is read from
// rather than on every render: a 300-node Flow renders again for each focus and selection.

import { computed } from "vue";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import type { Flow, FlowRun } from "../../../../src/board-model";
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
  readonly now: number;
  readonly installation: string;
  readonly live: boolean;
}

interface MenuItem {
  readonly label: string;
  readonly icon: string;
  readonly onSelect: () => void;
}

export interface NodeView {
  readonly name: string;
  readonly hover: string;
  readonly primary: FlowActionView | null;
  readonly menu: ReadonlyArray<MenuItem>;
  readonly steering: ReturnType<typeof stepSteering>;
}

export const nodeKey = (run: string, node: string) => `${run}\u0000${node}`;

export const useFlowNodes = (
  from: FlowNodesFrom,
  act: (action: FlowActionView, spot?: FlowSpot) => void,
) =>
  computed(() => {
    const { flow, cards, away, now, installation, live } = from;
    const lanes = new Map(Arr.map(flow.lanes, (lane) => [lane.run, lane] as const));
    const laneOf = (run: string) => lanes.get(run) ?? flow.lanes.at(-1);
    const nodes = new Map<string, NodeView>();
    const laneMenus = new Map<string, ReadonlyArray<MenuItem>>();
    for (const row of flowRows(flow)) {
      const lane = lanes.get(row.run);
      laneMenus.set(
        row.run,
        lane === undefined
          ? []
          : Arr.flatMap(lane.actions ?? [], (kind) => {
              const one = desktopLaneAction(kind, lane, installation, live);
              return one === null
                ? []
                : [{ label: one.label, icon: one.icon, onSelect: () => act(one) }];
            }),
      );
      const owner = laneOf(row.run);
      for (const node of row.nodes) {
        const spot = { run: row.run, node: node.id };
        const actionOf = (kind: NonNullable<FlowRun["primary"]>) =>
          owner === undefined ? null : desktopFlowAction(kind, node, owner, installation, live);
        const primary = node.primary == null ? null : actionOf(node.primary);
        const steering = stepSteering(node);
        const info = inspectorOf(flow, { ...spot, item: null }, now);
        nodes.set(nodeKey(row.run, node.id), {
          primary,
          steering,
          menu: Arr.flatMap([node.primary, ...(node.actions ?? [])], (kind) => {
            const one = kind == null ? null : actionOf(kind);
            return one === null
              ? []
              : [{ label: one.label, icon: one.icon, onSelect: () => act(one, spot) }];
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
          hover:
            info === null
              ? ""
              : Arr.join(
                  Arr.filter(
                    [
                      info.title,
                      pipe(info.state, Str.replaceAll("-", " ")),
                      info.said,
                      ...info.lines,
                    ],
                    (part): part is string => Boolean(part),
                  ),
                  "\n",
                ),
        });
      }
    }
    return { nodes, laneMenus };
  });
