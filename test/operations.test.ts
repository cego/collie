// Everything between a prepared Workflow and a Run, for a caller that was given its
// answers instead of asking them. The CLI drives this too, but through a subprocess;
// here it is exercised at its own interface.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { installBaseline } from "./support/engine";
import { installFakeSkills } from "./support/defs";
import { FakeBin } from "./support/bin";
import { postReview, prepareWorkflow, settleGiven, upgrade, type Failure } from "../src/operations";
import { REVIEW_FILE } from "../src/output";
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

const AskedInputs = Schema.Struct({ inputs: Schema.Array(Schema.Struct({ name: Schema.String })) });

/** The Input names a `needs_input` refusal says are still missing. */
function asked(result: Failure): string[] {
  return Schema.decodeUnknownOption(AskedInputs)(result.error.details).pipe(
    Option.map((detail) => detail.inputs.map((input) => input.name)),
    Option.getOrElse((): string[] => []),
  );
}

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

test("the workspace opt-in settles from --input and is never asked for", () =>
  runEffect(
    Effect.gen(function* () {
      const ready = yield* prepared("implement");

      yield* settleGiven(rig.pluginEnv(), ready, {
        inputs: { plan: "ENG-1", workspace: "new" },
        decide: [],
      });

      // Settled like any other declared Input, which is what lets both front doors and
      // a chained Run reach it: nothing intercepts it on the way.
      const workspace = ready.resolutions.find((r) => r.name === "workspace")!;
      expect(workspace.value).toBe("new");
      expect(workspace.needsAsking).toBe(false);

      // Left out, it settles to empty and is never one of the Inputs a run stops for:
      // an unattended `implement` must not be held up asking where it should live.
      const absent = yield* prepared("implement");
      const bare = yield* settleGiven(rig.pluginEnv(), absent, {
        inputs: { plan: "ENG-1" },
        decide: [],
      });
      // `target`, inherited from the embedded `review`, is what this run still needs —
      // stated up front so the assertion below cannot pass by asking for nothing at all.
      if (bare.ok) throw new Error("expected implement to still need its review target");
      expect(asked(bare)).toEqual(["target"]);
      expect(asked(bare)).not.toContain("workspace");
      const left = absent.resolutions.find((r) => r.name === "workspace")!;
      expect(left.value).toBe("");
      expect(left.needsAsking).toBe(false);
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

/** What `prepare.sh` says it did, in the shape upgrade reads it back in. */
const PREPARED = [
  "prepare: plugin-link: already in place",
  "prepare: runner: done",
  "prepare: operator-skill: done",
  "prepare: skills: skipped — no npx on PATH; install Node, then run `collie upgrade`",
].join("\n");

/** A checkout that answers `git` and a `prepare.sh` that says what it did. */
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
  // A marker, so a test can tell "the preparation ran" from "it was never reached".
  yield* bin.add(
    "sh",
    opts.install ??
      `touch "${rig.root}/installed"; cat <<'OUT'
${PREPARED}
OUT`,
  );
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
      // Every step of preparing the machine, so "nothing to do" reads differently
      // from "the runner updated but the skills step could not run".
      expect(same.ok && same.human).toMatch(/plugin-link\s+already in place/);
      expect(same.ok && same.human).toMatch(/runner\s+done/);
      expect(same.ok && same.human).toMatch(/skills\s+skipped — no npx on PATH/);
      expect(same).toMatchObject({
        data: {
          steps: [
            { step: "plugin-link", state: "already in place" },
            { step: "runner", state: "done" },
            { step: "operator-skill", state: "done" },
            { step: "skills", state: "skipped" },
          ],
        },
      });
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

test("upgrade that moves the checkout says the range it moved through", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      // A HEAD that differs before and after the pull: the commit range is what tells
      // "you are now three commits newer" from "nothing to do".
      yield* bin.add(
        "git",
        `case "$1 $2" in
          "rev-parse --git-dir") echo .git ;;
          "rev-parse --short") if [ -f "${rig.root}/pulled" ]; then echo def5678; else echo abc1234; fi ;;
          "pull --ff-only") touch "${rig.root}/pulled"; echo Updating ;;
          *) exit 1 ;;
        esac`,
      );
      yield* bin.add(
        "sh",
        `cat <<'OUT'
${PREPARED}
OUT`,
      );

      const moved = yield* upgrade(env);

      expect(moved).toMatchObject({
        ok: true,
        data: { checkout: true, updated: true, before: "abc1234", after: "def5678" },
      });
      expect(moved.ok && moved.human).toContain("from abc1234 to def5678");
      expect(moved.ok && moved.human).toMatch(/skills\s+skipped/);
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

/** A finished Run over one target, with or without the review it wrote. */
const reviewed = Effect.fn("operationsTest.reviewed")(function* (
  target: string,
  review: string | null,
) {
  const env = rig.pluginEnv();
  const run = yield* new RunStore(env.stateDir).create({
    workflow: "review",
    cwd: env.cwd,
    session: env.socketPath,
    workspace: env.workspaceId,
    workspaceLabel: "test",
    inputs: { target },
    inputSources: {},
    stepIds: ["review"],
    maxIterations: 1,
    primaryInput: "target",
  });
  if (review !== null) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${run.dir}/${REVIEW_FILE}`, review);
  }
  return run;
});

/**
 * The Choice and the app's merge-request panel both post a review, so the behaviour
 * lives in one place. These are that place's own tests; `test/review-e2e.test.ts`
 * proves the Choice still reaches it.
 */
test("posting a review sends review.md to the merge request it reviewed", () =>
  runEffect(
    Effect.gen(function* () {
      const notes = `${rig.root}/bin/notes.txt`;
      yield* bin.add("glab", `printf '%s\\n' "$@" > ${notes}\nexit 0`);
      const run = yield* reviewed("mr:gitlab.example.com/g/p!12", "# Review\n\nAll good.\n");

      const posted = yield* postReview(run);

      expect(posted).toEqual({
        ok: true,
        message: "posted the review to gitlab.example.com/g/p!12",
      });
      const fs = yield* FileSystem.FileSystem;
      // One note, with --repo so no checkout is needed, and review.md verbatim.
      expect(yield* fs.readFileString(notes)).toBe(
        "mr\nnote\n12\n--repo\ngitlab.example.com/g/p\n--message\n# Review\n\nAll good.\n\n",
      );
    }),
  ));

test("a run with no review, or no merge request, says which and posts nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const notes = `${rig.root}/bin/notes.txt`;
      yield* bin.add("glab", `printf '%s\\n' "$@" > ${notes}\nexit 0`);

      const noReview = yield* reviewed("mr:gitlab.example.com/g/p!12", null);
      expect(yield* postReview(noReview)).toEqual({
        ok: false,
        message: `there is no ${REVIEW_FILE} to post`,
      });

      const notAnMr = yield* reviewed("worktree", "# Review\n");
      expect(yield* postReview(notAnMr)).toEqual({
        ok: false,
        message: "worktree is not a merge request",
      });

      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(notes)).toBe(false);
    }),
  ));

test("a glab that refuses is reported rather than reported as posted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 3`);
      const run = yield* reviewed("mr:gitlab.example.com/g/p!12", "# Review\n");

      expect(yield* postReview(run)).toEqual({
        ok: false,
        message: "glab mr note gitlab.example.com/g/p!12 failed (exit 3)",
      });
    }),
  ));

test("a workflow that still needs an answer settles nothing and says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* installFakeSkills(rig.root);
      const env = rig.pluginEnv();

      const prepared = yield* prepareWorkflow(env, "plan");
      if (!prepared.ok) throw new Error("expected plan to prepare");
      const settled = yield* settleGiven(env, prepared, { inputs: {}, decide: [] });

      // What `collie run start` and every non-interactive caller depend on: an Input
      // nobody could infer is the caller's to give, and nothing is half-created for it.
      expect(settled.ok).toBe(false);
      if (settled.ok) return;
      expect(settled.error.code).toBe("needs_input");
      expect(yield* new RunStore(env.stateDir).list()).toHaveLength(0);
    }),
  ));
