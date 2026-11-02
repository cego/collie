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
  entry: "/project/.collie/workflows/builds.workflow.ts",
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
  awaiting: null,
  mr: null,
  landing: null,
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

test("a Run parked inside a wait, still pending, is waiting on you rather than working", () => {
  const parked = view({ parked: "r1-review-r1 in pane 1-1 was sent delivery r1-review-step-1…" });
  expect(factsOfView("/state", parked).state).toBe("waiting");
});

test("a Run awaiting what comes by itself is working, and says what it awaits", () => {
  const awaiting = { on: "CI on group/app!3", who: null, since: "2026-10-21T10:00:00.000Z" };
  const facts = factsOfView("/state", view({ status: { status: "suspended" }, awaiting }));
  expect(facts.state).toBe("running");
  expect(facts.awaiting).toEqual(awaiting);
  expect(facts.note).toBe("Waiting for CI on group/app!3.");
  const repair = factsOfView(
    "/state",
    view({ parked: "group/app!3 cannot be released", awaiting }),
  );
  expect(repair.state).toBe("waiting");
  expect(repair.note).toBe("group/app!3 cannot be released");
});

test("a Run stopped or failed on its question asks nobody, and keeps the question for a resume", () => {
  const post = {
    name: "post-1",
    prompt: "What next?",
    options: ["Post", "Don't post"],
    answer: null,
  };
  const asking = view({ status: { status: "suspended" }, waiting: [post] });
  expect(factsOfView("/state", asking).asking).toEqual([
    { name: "post-1", prompt: "What next?", options: ["Post", "Don't post"] },
  ]);

  const stopped = factsOfView("/state", { ...asking, controls: ["stop"] });
  expect(stopped.state).toBe("stopped");
  expect(stopped.asking).toEqual([]);
  expect(stopped.engine?.questions).toMatchObject([{ name: "post-1", open: false, answered: null }]);

  const failed = factsOfView(
    "/state",
    view({
      status: {
        status: "failed",
        reason: "boom",
        entry: "/project/.collie/workflows/builds.workflow.ts",
      },
      waiting: [post],
    }),
  );
  expect(failed.asking).toEqual([]);
});
