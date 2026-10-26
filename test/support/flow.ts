import type { Flow, FlowNode } from "../../src/board-model";

export const flowNode = (id: string, over: Partial<FlowNode> = {}): FlowNode => ({
  id,
  title: id[0]!.toUpperCase() + id.slice(1),
  kind: "agent",
  description: "Work on the current Slice.",
  role: "builder",
  declared: true,
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
  runs: [],
  ...over,
});

export const mainFlow = (extra: ReadonlyArray<FlowNode> = []): Flow => ({
  lanes: [
    {
      run: "plan-run",
      workflow: "plan",
      title: "Plan",
      machine: "laptop",
      execution: "completed",
      declared: true,
      requestedBy: null,
      nodes: [
        flowNode("grill", { state: "done" }),
        flowNode("spec", { state: "done", produces: "plan" }),
      ],
    },
    {
      run: "build-run",
      workflow: "implement",
      title: "Implement",
      machine: "laptop",
      execution: "running",
      declared: true,
      requestedBy: null,
      nodes: [
        flowNode("build", {
          state: "running",
          said: "Slice 4 of 6",
          ranOn: "claude/opus",
          started: "2026-10-23T09:00:00.000Z",
          runs: [
            ...["01", "02", "03"].map((id) =>
              flowNode(`build@${id}`, { title: id, state: "done" }),
            ),
            flowNode("build@04", {
              title: "04",
              state: "running",
              ranOn: "codex/default",
              started: "2026-10-23T09:05:00.000Z",
            }),
            flowNode("build@05", { title: "05" }),
            flowNode("build@06", { title: "06" }),
          ],
        }),
        flowNode("review"),
        flowNode("mr", { produces: "merge-request" }),
        ...extra,
      ],
    },
  ],
  current: { run: "build-run", node: "build" },
  release: [flowNode("ci", { kind: "release" }), flowNode("merged", { kind: "release" })],
});
