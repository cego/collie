// Everything between a prepared Workflow and a Run, for a caller that was given its
// answers instead of asking them. The CLI drives this too, but through a subprocess;
// here it is exercised at its own interface.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { installBaseline } from "./support/engine";
import { installFakeSkills } from "./support/defs";
import { FakeBin } from "./support/bin";
import { prepareWorkflow, settleGiven, upgrade } from "../src/operations";
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

/** A checkout that answers `git` and an `install.sh` that says what it did. */
const fakeTools = Effect.fn("operationsTest.fakeTools")(function* (opts: {
  head: string;
  pull?: string;
  install?: string;
}) {
  yield* bin.add(
    "git",
    `case "$1 $2" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --short") echo ${opts.head} ;;
      "pull --ff-only") ${opts.pull ?? "echo Updating; exit 0"} ;;
      *) exit 1 ;;
    esac`,
  );
  // A marker, so a test can tell "the install ran" from "it was never reached".
  yield* bin.add("sh", opts.install ?? `touch "${rig.root}/installed"; echo installed; exit 0`);
});

test("upgrade pulls the checkout, then installs, and says what moved", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      yield* fakeTools({ head: "abc1234" });

      const same = yield* upgrade(env);

      // Nothing moved: the same HEAD before and after is worth saying plainly rather
      // than reporting an update that did not happen.
      expect(same).toMatchObject({ ok: true, data: { checkout: true, updated: false } });
      expect(same.ok && same.human).toContain("already up to date at abc1234");
      expect(same.ok && same.human).toContain("installed");
    }),
  ));

test("upgrade reports a pull it could not do rather than installing anyway", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      // A dirty tree, a diverged branch, no upstream: all the same answer.
      yield* fakeTools({
        head: "abc1234",
        pull: `echo "would clobber local changes" >&2; exit 1`,
      });

      const refused = yield* upgrade(env);

      expect(refused).toMatchObject({
        ok: false,
        error: { code: "operation_failed", details: { output: "would clobber local changes" } },
      });
      // And it did not go on to install over the top of whatever is there.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${rig.root}/installed`)).toBe(false);
    }),
  ));

test("upgrade of a plain install fetches the release without asking git anything", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      // Not a checkout: `git rev-parse --git-dir` fails, and there is nothing to pull.
      yield* bin.add("git", `exit 1`);
      yield* bin.add("sh", `echo installed collie-linux-x64; exit 0`);

      const fetched = yield* upgrade(env);

      expect(fetched).toMatchObject({ ok: true, data: { checkout: false, updated: false } });
      expect(fetched.ok && fetched.human).toContain("not a checkout");
    }),
  ));
