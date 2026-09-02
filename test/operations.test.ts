// Everything between a prepared Workflow and a Run, for a caller that was given its
// answers instead of asking them. The CLI drives this too, but through a subprocess;
// here it is exercised at its own interface.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { installBaseline } from "./support/engine";
import { installFakeSkills } from "./support/defs";
import { FakeBin } from "./support/bin";
import { prepareWorkflow, settleGiven } from "../src/operations";
import { RunStore } from "../src/run";

let rig: Rig;
let bin: FakeBin;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(`${rig.root}/bin`);
      yield* installFakeSkills(rig.root);
      // Inference shells out; nothing here depends on what it finds.
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

const prepared = Effect.fn("operationsTest.prepared")(function* (workflow: string) {
  const ready = yield* prepareWorkflow(rig.pluginEnv(), workflow);
  if (!ready.ok) return yield* Effect.fail(new Error(ready.error.message));
  return ready;
});

test("a given diff-target is normalised, not just recorded", () =>
  runEffect(
    Effect.gen(function* () {
      const ready = yield* prepared("review");

      const settled = yield* settleGiven(rig.pluginEnv(), ready, {
        inputs: { target: "https://gitlab.cego.dk/cego/collie/-/merge_requests/2" },
        decide: [],
      });

      expect(settled.ok).toBe(true);
      const target = ready.resolutions.find((r) => r.name === "target")!;
      // A URL that stayed a URL classifies as `worktree` and renders `{{target_repo}}`
      // empty, which is the defect this settles.
      expect(target.value).toBe("mr:gitlab.cego.dk/cego/collie!2");
      expect(target.kind).toBe("mr");
    }),
  ));

test("a decision is checked against the Workflow's own steps and titles", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();

      const taken = yield* settleGiven(env, yield* prepared("review"), {
        inputs: { target: "worktree" },
        decide: ["post=Don't post"],
      });
      expect(taken).toMatchObject({ ok: true, decisions: { post: "Don't post" } });

      const badStep = yield* settleGiven(env, yield* prepared("review"), {
        inputs: { target: "worktree" },
        decide: ["nope=Don't post"],
      });
      expect(badStep).toMatchObject({ ok: false, error: { code: "invalid_input" } });

      const badTitle = yield* settleGiven(env, yield* prepared("review"), {
        inputs: { target: "worktree" },
        decide: ["post=Ship it"],
      });
      expect(badTitle).toMatchObject({ ok: false, error: { code: "invalid_input" } });

      // A run id that is not there is refused before anything is created.
      const noPrevious = yield* settleGiven(env, yield* prepared("review"), {
        inputs: { target: "worktree", previous: "review-nope-20260101-000000" },
        decide: [],
      });
      expect(noPrevious).toMatchObject({ ok: false, error: { code: "invalid_input" } });

      // So is one that never wrote a review: the engine would fall back to no previous
      // review and the run would compare against nothing without saying so.
      const empty = yield* new RunStore(rig.stateDir).create({
        workflow: "review",
        cwd: rig.projectDir,
        inputs: { target: "worktree" },
        inputSources: { target: "inferred" },
        stepIds: ["review"],
        maxIterations: 1,
        primaryInput: "working tree",
      });
      const reviewless = yield* settleGiven(env, yield* prepared("review"), {
        inputs: { target: "worktree", previous: empty.id },
        decide: [],
      });
      expect(reviewless).toMatchObject({
        ok: false,
        error: { code: "invalid_input", message: expect.stringContaining("no review") },
      });

      // And a `../` id cannot walk out of the state dir to read someone else's.
      const traversal = yield* settleGiven(env, yield* prepared("review"), {
        inputs: { target: "worktree", previous: "../../etc" },
        decide: [],
      });
      expect(traversal).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }),
  ));

test("an Input nobody can be asked for comes back as needs_input", () =>
  runEffect(
    Effect.gen(function* () {
      const settled = yield* settleGiven(rig.pluginEnv(), yield* prepared("plan"), {
        inputs: {},
        decide: [],
      });

      expect(settled).toMatchObject({ ok: false, error: { code: "needs_input" } });
    }),
  ));
