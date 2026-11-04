import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { reactive } from "vue";
import type { Flow } from "../../src/board-model";
import type { FlowSelection, FlowSpot } from "../src/shared/flow";
import { nodeKey, useFlowNodes, type FlowNodesFrom } from "../view/app/composables/useFlowNodes";
import { flowNode } from "../../test/support/flow";

const flowOf = (said: string): Flow => ({
  lanes: Arr.makeBy(3, (lane) => ({
    run: `r-${lane}`,
    workflow: "implement",
    title: "Implement",
    machine: "laptop",
    execution: "running",
    declared: true,
    requestedBy: null,
    nodes: Arr.makeBy(100, (at) => flowNode(`s-${at}`, { state: "done", said })),
  })),
  current: null,
  release: null,
});

test("a 300-node Flow's node views are read once per revision, not again for a focus or a selection", () => {
  const props = reactive<
    FlowNodesFrom & {
      focused: FlowSpot | null;
      selected: FlowSelection | null;
      rail: boolean;
    }
  >({
    flow: flowOf("first"),
    focused: null,
    selected: null,
    rail: false,
    cards: [],
    away: new Set<string>(),
    now: 0,
    installation: "inst-1",
    live: true,
  });
  const drawn = useFlowNodes(props, () => {});
  const first = drawn.value;
  expect(first.nodes.size).toBe(300);
  for (let at = 0; at < 10; at++) {
    props.focused = { run: "r-1", node: `s-${at}` };
    props.selected = { run: "r-2", node: `s-${at}`, item: null };
    props.rail = at % 2 === 0;
    expect(drawn.value).toBe(first);
  }
  props.flow = flowOf("second");
  expect(drawn.value).not.toBe(first);
  expect(drawn.value.nodes.get(nodeKey("r-0", "s-0"))?.hover).toContain("second");
});
