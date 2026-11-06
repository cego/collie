// Whether a record painted the host's Flow: each row, node and action by its accessible
// name, and each node's attempts and wait, which no name carries.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { Flow, FlowRun } from "../../src/board-model";
import { flowRows, nodeName } from "../../desktop/src/shared/flow";
import { desktopFlowAction } from "../../desktop/src/shared/flow-actions";
import { stepSteering } from "../../desktop/src/shared/step-steering";

export interface PaintedNode {
  readonly name: string;
  readonly attempts: number;
  readonly wait: string | null;
  readonly actions: ReadonlyArray<string>;
}
export interface PaintedRow {
  readonly name: string;
  readonly nodes: ReadonlyArray<PaintedNode>;
}
export type Painted = ReadonlyArray<PaintedRow>;

/** What FlowMap paints of `flow` on a live Machine with nothing linked away. */
export const paintedOf = (flow: Flow, installation: string): Painted =>
  Arr.map(flowRows(flow), (row) => {
    const lane = Option.getOrElse(
      Arr.findFirst(flow.lanes, (one) => one.run === row.run),
      () => flow.lanes.at(-1),
    );
    const primary = (node: FlowRun) =>
      lane === undefined || node.primary == null
        ? null
        : desktopFlowAction(node.primary, node, lane, installation, true);
    return {
      name: row.name,
      nodes: Arr.map(row.nodes, (node) => {
        const action = primary(node)?.label;
        const steering = stepSteering(node);
        return {
          name: Arr.join(
            Arr.filter(
              [nodeName(node, { action }), steering.pause, steering.badge],
              (part): part is string => part !== null && part !== "",
            ),
            ". ",
          ),
          attempts: node.attempts.length,
          wait: node.wait,
          actions: action === undefined ? [] : [action],
        };
      }),
    };
  });

const listed = (names: ReadonlyArray<string>) => `"${Arr.join(names, ", ")}"`;

/** How `shown` differs from `host`, empty where it is the same Flow. */
export const differences = (shown: Painted, host: Painted): ReadonlyArray<string> => {
  if (shown.length !== host.length || Arr.some(shown, (row, at) => row.name !== host[at]!.name))
    return [
      `rows are ${listed(Arr.map(shown, (row) => row.name))}, not ${listed(Arr.map(host, (row) => row.name))}`,
    ];
  return Arr.flatMap(shown, (row, at) => {
    const expected = host[at]!;
    if (row.nodes.length !== expected.nodes.length)
      return [`${row.name}: ${row.nodes.length} nodes, not ${expected.nodes.length}`];
    return Arr.flatMap(row.nodes, (node, i) => {
      const want = expected.nodes[i]!;
      if (node.name !== want.name)
        return [`${row.name}: node ${i + 1} is "${node.name}", not "${want.name}"`];
      return [
        ...(node.attempts === want.attempts
          ? []
          : [`${row.name}: ${node.name} has ${node.attempts} attempts, not ${want.attempts}`]),
        ...(node.wait === want.wait
          ? []
          : [`${row.name}: ${node.name} waits on ${node.wait}, not ${want.wait}`]),
        ...(listed(node.actions) === listed(want.actions)
          ? []
          : [
              `${row.name}: ${node.name} offers ${listed(node.actions)}, not ${listed(want.actions)}`,
            ]),
      ];
    });
  });
};
