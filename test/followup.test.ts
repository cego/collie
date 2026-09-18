// A finished Run is immutable, so a follow-up is a child of it and not a reopening. What
// is tested here is the guards on the checkout it inherits: each refusal names its own
// condition, because "cannot" is not something a human can act on.

import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { followUp } from "../src/operations";
import { RunStore, type Run } from "../src/run";
import { appendDrift } from "../src/drift";
import { readIntent, seedIntent, writeIntent } from "../src/intent";
import { classifyWorkSource } from "../src/inputs";
import { currentEnv, type PluginEnv } from "../src/env";
import { runEffect } from "./support/effect";
import { withSkills } from "./support/skills";

let stateDir: string;
let repo: string;
let env: PluginEnv;
let driverLog: string;
let driverLayer: Layer.Layer<never>;

/** Every follow-up here hands its child to the fake Driver, the way a real one does. */
function withDriver<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.provide(driverLayer));
}

const git = (args: string[], cwd = repo) =>
  Effect.sync(() => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-followup-" });
      repo = yield* fs.makeTempDirectory({ prefix: "hw-followup-repo-" });
      yield* git(["init", "-q", "-b", "feat/picker"]);
      yield* git(["config", "user.email", "t@example.com"]);
      yield* git(["config", "user.name", "t"]);
      yield* fs.writeFileString(path.join(repo, "a.ts"), "one\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "first"]);
      // A child is handed to a detached Driver like any other Run, so there has to be
      // something to hand it to; this records the Run ids it was started for.
      driverLog = path.join(stateDir, "drivers");
      const driver = path.join(stateDir, "fake-driver");
      yield* fs.writeFileString(
        driver,
        `#!/bin/sh\nprintf '%s\\n' "$COLLIE_RUN" >> "${driverLog}"\n`,
        { mode: 0o755 },
      );
      driverLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({ COLLIE_DRIVER: driver }));
      env = yield* withSkills({ ...(yield* currentEnv), stateDir, socketPath: null }, "implement");
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
      yield* fs.remove(repo, { recursive: true, force: true });
    }),
  ),
);

const parentRun = Effect.fn("test.parentRun")(function* (over: { finished?: boolean } = {}) {
  const run: Run = yield* new RunStore(stateDir).create({
    workflow: "implement",
    cwd: repo,
    inputs: { plan: "add a picker" },
    inputSources: { plan: "asked" },
    stepIds: ["build"],
    maxIterations: 5,
    namedAfter: "add-a-picker",
    worktree: {
      path: repo,
      branch: "feat/picker",
      created_by_collie: true,
      managed_by: "git",
      workspace_id: null,
      made_at: null,
      root_tab_id: null,
      root_pane_id: null,
    },
  });
  if (over.finished !== false) {
    run.record.status = "done";
    run.record.finished_at = "2026-09-09T10:00:00Z";
    for (const step of run.record.steps) step.status = "done";
    yield* run.save();
  }
  yield* writeIntent(run.dir, seedIntent(run.id, { goal: "add a picker" }));
  return run;
});

test("`followup:<id>` is a work source of its own, named rather than inferred", () =>
  runEffect(
    Effect.gen(function* () {
      const classified = yield* classifyWorkSource("followup:implement-picker-1");
      expect(classified.kind).toBe("followup");
      expect(classified.label).toBe("implement-picker-1");
      // Anything else is still whatever it was.
      expect((yield* classifyWorkSource("just some words")).kind).toBe("text");
    }),
  ));

test("a Run that is still going cannot be followed up", () =>
  runEffect(
    Effect.gen(function* () {
      const run = yield* parentRun({ finished: false });
      const refused = yield* withDriver(followUp(env, run, "finish the exporter", "req-1"));
      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      if (!refused.ok) expect(refused.error.message).toContain("has finished");
    }),
  ));

test("each worktree guard refuses on its own, and says which one it was", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = yield* parentRun();

      // Uncommitted changes: the follow-up would build on somebody's unfinished work.
      yield* fs.writeFileString(path.join(repo, "a.ts"), "two\n");
      const dirty = yield* withDriver(followUp(env, run, "carry on", "req-2"));
      expect(dirty).toMatchObject({ ok: false });
      if (!dirty.ok) expect(dirty.error.message).toContain("--allow-dirty");

      // Said so explicitly: that is a decision, and it is allowed.
      const allowed = yield* withDriver(
        followUp(env, run, "carry on", "req-3", { allowDirty: true }),
      );
      expect(allowed.ok).toBe(true);

      // A checkout that moved to another branch is not the one that Run built.
      yield* git(["checkout", "-q", "-b", "somewhere-else"]);
      const moved = yield* withDriver(
        followUp(env, run, "carry on", "req-4", { allowDirty: true }),
      );
      expect(moved).toMatchObject({ ok: false });
      if (!moved.ok) expect(moved.error.message).toContain("not feat/picker");
    }),
  ));

test("the child is a Run of its own, and the parent is only told it exists", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = yield* parentRun();
      yield* appendDrift(run.dir, {
        id: "d1",
        at: "t",
        run: run.id,
        intent_version: 1,
        constraint: "c1",
        kind: "rule",
        severity: "block",
        evidence: [{ kind: "diff", path: "docs/using.md" }],
        evidence_truncated: false,
        resolution: "open",
      });

      const started = yield* withDriver(
        followUp(env, run, "the docs change is still outside src/", "req-5"),
      );
      if (!started.ok) throw new Error(started.error.message);

      const store = new RunStore(stateDir);
      const parent = yield* store.load(run.id);
      const childId = parent.record.children.at(-1)!;
      const child = yield* store.load(childId);

      // A child, with its own record and its own work source.
      expect(child.record.parent).toBe(run.id);
      expect(child.record.inputs.plan).toBe(`followup:${run.id}`);
      expect(child.record.inputs.plan_kind).toBe("followup");
      expect(child.record.workflow).toBe("implement");

      // The spec is the human's words plus what was still open — in the child's own plan
      // directory, because a finished Run's is not ours to write.
      const spec = yield* fs.readFileString(path.join(child.dir, "plan", "SPEC.md"));
      expect(spec).toContain("the docs change is still outside src/");
      expect(spec).toContain("c1 (block)");
      expect(spec).toContain("docs/using.md");

      // The parent's Intent, inherited and re-sourced; the parent's record otherwise
      // untouched but for `children`.
      const intent = yield* readIntent(child.dir);
      expect(intent?.parent).toEqual({ run: run.id, version: 1, applied: 1 });
      expect(parent.record.status).toBe("done");
      expect(parent.record.finished_at).toBe("2026-09-09T10:00:00Z");

      // And it was handed to a Driver of its own, like any other Run.
      expect((yield* fs.readFileString(driverLog)).trim().split("\n")).toContain(childId);
    }),
  ));
