// The taxonomy is the contract: what is sent, how it is titled, and how often.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { EffectFakeHerdr } from "./support/engine";
import { RunStore } from "../src/run";
import { NOTIFICATION_KINDS, alreadySent, notificationTitle, notify, wanted } from "../src/notify";

const makeRun = Effect.fn("notifyTest.makeRun")(function* (rig: Rig) {
  return yield* new RunStore(rig.stateDir).create({
    workflow: "review",
    cwd: rig.projectDir,
    inputs: { target: "worktree" },
    inputSources: { target: "inferred" },
    stepIds: ["review", "post"],
    maxIterations: 1,
    primaryInput: "working tree",
  });
});

test("every kind names the repo and the run, and none of them is a bare slug", () => {
  // One herdr session runs several checkouts, so `review-mr-123 needs you` does not
  // say which one.
  for (const kind of NOTIFICATION_KINDS) {
    const title = notificationTitle(kind, "/home/mk/work/collie", "review-mr-2");
    expect(title.startsWith("collie · review-mr-2 ")).toBe(true);
  }
  expect(notificationTitle("run-done", "/home/mk/work/collie/", "review-mr-2")).toBe(
    "collie · review-mr-2 finished",
  );
  expect(notificationTitle("decision-lost", "/x/repo", "s")).toBe("repo · s is asking after all");
});

test("a kind turned off in settings is not sent, and everything else is", () => {
  expect(wanted({}, "run-done")).toBe(true);
  expect(wanted({ "run-done": true }, "run-done")).toBe(true);
  expect(wanted({ "run-done": false }, "run-done")).toBe(false);
  expect(wanted({ "run-done": false }, "needs-you")).toBe(true);
});

test("the same question at the same step toasts once, even across Drivers", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      const herdr = new EffectFakeHerdr(rig.pluginEnv(), rig.env());
      const run = yield* makeRun(rig);

      yield* notify(herdr, run, { kind: "needs-you", body: "review: pick", step: "review" });
      yield* notify(herdr, run, { kind: "needs-you", body: "review: pick", step: "review" });
      // A different step is a different question, and says so.
      yield* notify(herdr, run, { kind: "needs-you", body: "post: pick", step: "post" });
      // Off in settings sends nothing at all.
      yield* notify(herdr, run, {
        kind: "run-done",
        body: "clean",
        settings: { "run-done": false },
      });

      const toasts = (yield* rig.calls()).filter((c) => c.cmd === "notification show");
      expect(toasts).toHaveLength(2);
      expect(toasts.map((c) => c.argv!.at(-1))).toEqual(["review: pick", "post: pick"]);

      // What was said is on the record, so a resumed Driver does not say it again.
      const reloaded = yield* new RunStore(rig.stateDir).load(run.id);
      expect(alreadySent(reloaded, "needs-you", "review")).toBe(true);
      expect(alreadySent(reloaded, "needs-you", "synthesize")).toBe(false);
      yield* rig.close();
    }),
  ));

test("a herdr that will not toast never fails the Run", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rig = yield* Rig.make();
      const env = { FAKE_HERDR_FAIL: `{"notification show":"no notifier"}` };
      const herdr = new EffectFakeHerdr(rig.pluginEnv(env), rig.env(env));
      const run = yield* makeRun(rig);

      yield* notify(herdr, run, { kind: "run-failed", body: "it died" });

      expect(yield* fs.exists(run.dir)).toBe(true);
      yield* rig.close();
    }),
  ));
