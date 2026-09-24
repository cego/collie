import { expect, test } from "bun:test";
import type { RunView } from "../src/engine";
import { factsOfView } from "../src/runs";

const view = (over: Partial<RunView> = {}): RunView => ({
  runId: "r1",
  workflow: "builds",
  project: "/project",
  task: null,
  parent: null,
  registration: "builds@1",
  entry: "/project/.herdr/workflows/builds.workflow.ts",
  input: {},
  provenance: {},
  strategies: {},
  options: {},
  cwd: "/project",
  branch: null,
  workspace: null,
  worktree: null,
  outcome: "unspecified",
  created: "2026-09-23T10:00:00Z",
  status: { status: "pending" },
  waiting: [],
  controls: [],
  diagnostic: null,
  parked: null,
  mr: null,
  ...over,
});

test("a Run the host suspended on a stop is stopped, not working", () => {
  const stopped = view({ status: { status: "suspended" }, controls: ["stop"] });
  expect(factsOfView("/state", stopped).state).toBe("stopped");
  // Still going, with the stop not yet reached, is the stop's too.
  expect(factsOfView("/state", view({ controls: ["stop"] })).state).toBe("stopped");
  expect(factsOfView("/state", view({ status: { status: "suspended" } })).state).toBe("running");
});

test("the merge request a Run opened is one of its facts", () => {
  const opened = view({ mr: "https://gitlab.example.com/group/app/-/merge_requests/7" });
  expect(factsOfView("/state", opened).mr).toBe(opened.mr);
});
