import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import type { Mutable } from "effect/Types";
import { reactive } from "vue";
import type { Flow } from "../../src/board-model";
import type { FlowSelection, FlowSpot } from "../src/shared/flow";
import { nodeKey, useFlowNodes, type FlowNodesFrom } from "../view/app/composables/useFlowNodes";
import { flowNode } from "../../test/support/flow";

const flowOf = (said: string, changed?: string): Flow => ({
  lanes: Arr.makeBy(3, (lane) => ({
    run: `r-${lane}`,
    workflow: "implement",
    title: "Implement",
    machine: "laptop",
    execution: "running",
    declared: true,
    requestedBy: null,
    nodes: Arr.makeBy(100, (at) =>
      flowNode(`s-${at}`, {
        state: "done",
        said: changed !== undefined && lane === 0 && at === 5 ? changed : said,
      }),
    ),
  })),
  current: null,
  release: null,
});

test("a 300-node Flow's node views are read once per revision, not again for a focus or a selection", () => {
  const props = reactive<
    Mutable<FlowNodesFrom> & {
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
  const drawn = useFlowNodes(props);
  const first = drawn.value;
  expect(Rec.size(first.nodes)).toBe(300);
  for (let at = 0; at < 10; at++) {
    props.focused = { run: "r-1", node: `s-${at}` };
    props.selected = { run: "r-2", node: `s-${at}`, item: null };
    props.rail = at % 2 === 0;
    expect(drawn.value).toBe(first);
  }
  props.flow = flowOf("second");
  expect(drawn.value).not.toBe(first);
  expect(drawn.value.nodes[nodeKey("r-0", "s-0")]?.hover).toContain("second");
});

test("a Flow sent again keeps each unchanged node's view, so only a changed Step is drawn again", () => {
  const props = reactive<Mutable<FlowNodesFrom>>({
    flow: flowOf("first"),
    cards: [],
    away: new Set<string>(),
    now: 0,
    installation: "inst-1",
    live: true,
  });
  const drawn = useFlowNodes(props);
  const first = drawn.value;
  props.flow = flowOf("first");
  expect(drawn.value).toBe(first);
  props.flow = flowOf("first", "changed");
  const next = drawn.value.nodes;
  expect(next[nodeKey("r-0", "s-5")]).not.toBe(first.nodes[nodeKey("r-0", "s-5")]);
  expect(next[nodeKey("r-0", "s-5")]?.hover).toContain("changed");
  for (const key of [nodeKey("r-0", "s-4"), nodeKey("r-1", "s-5"), nodeKey("r-2", "s-99")])
    expect(next[key]).toBe(first.nodes[key]!);
});
