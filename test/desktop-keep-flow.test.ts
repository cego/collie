// A record's Flow is sent and timed again whole; what is unchanged in it keeps its identity,
// so only a changed Step is drawn again.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { Flow, FlowNode } from "../src/board-model";
import { keepFlow } from "../desktop/src/shared/flow";
import { flowNode, mainFlow } from "./support/flow";

const child = (said: string) =>
  flowNode("child", {
    state: "running",
    said,
    notes: [{ id: "n", by: "mk", at: "2026-11-04T10:00:00Z", text: "t", read: null }],
  });
const sent = (said: string, extra: ReadonlyArray<FlowNode> = []): Flow =>
  mainFlow([child(said), ...extra]);
/** The lane `mainFlow` puts extra Steps in. */
const BUILD = 1;

test("a Flow sent again as it was is the Flow already drawn", () => {
  const before = sent("working");
  expect(keepFlow(sent("working"), before)).toBe(before);
});

test("a changed Step is new, and every other Step and lane is the one already drawn", () => {
  const before = sent("working");
  const next = sent("still working");
  const kept = keepFlow(next, before);
  expect(kept).toEqual(next);
  const was = before.lanes[BUILD]!.nodes;
  const now = kept.lanes[BUILD]!.nodes;
  for (let at = 0; at < now.length; at++)
    if (now[at]!.id === "child") {
      expect(now[at]).not.toBe(was[at]);
      expect(now[at]!.said).toBe("still working");
    } else expect(now[at]).toBe(was[at]!);
  for (let at = 0; at < kept.lanes.length; at++)
    if (at !== BUILD) expect(kept.lanes[at]).toBe(before.lanes[at]!);
});

test("a Step added, or a lane changed outside its Steps, is drawn as new", () => {
  const before = sent("working");
  const grown = keepFlow(sent("working", [flowNode("more")]), before);
  expect(Arr.map(grown.lanes[BUILD]!.nodes, (node) => node.id)).toContain("more");
  const failed = sent("working");
  const moved = keepFlow(
    {
      ...failed,
      lanes: Arr.map(failed.lanes, (lane, at) =>
        at === BUILD ? { ...lane, execution: "failed" as const } : lane,
      ),
    },
    before,
  );
  expect(moved.lanes[BUILD]!.execution).toBe("failed");
  expect(moved.lanes[BUILD]!.nodes).toBe(before.lanes[BUILD]!.nodes);
  expect(keepFlow(sent("working"), null)).toEqual(sent("working"));
});
