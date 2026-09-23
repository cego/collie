import { expect, test } from "bun:test";
import type { RunView } from "../src/engine";
import { factsOfHistory, factsOfView } from "../src/runs";
import type { HistoryRow } from "../src/store";

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

const history = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  run: "old-1",
  workflow: "renovate",
  project: "/project",
  status: "done",
  outcome: "unspecified",
  created: "2026-09-01T10:00:00Z",
  finished: "2026-09-01T11:00:00Z",
  task: null,
  parent: null,
  inputs: "{}",
  provenance: "{}",
  evidence: '{"dir":"/state/runs/old-1","mr":null}',
  summary: null,
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

test("an imported Run keeps the branch its checkout or its inputs named", () => {
  const onWorktree = history({
    evidence:
      '{"dir":"/state/runs/old-1","mr":null,"worktree":{"path":"/wt","branch":"mk/bump","managed_by":"git","workspace_id":null,"created_by_collie":true,"made_at":0,"root_tab_id":null,"root_pane_id":null}}',
  });
  expect(factsOfHistory("/state", onWorktree).branch).toBe("mk/bump");
  expect(factsOfHistory("/state", history({ inputs: '{"branch":"mk/asked"}' })).branch).toBe(
    "mk/asked",
  );
  expect(factsOfHistory("/state", history()).branch).toBeNull();
});
