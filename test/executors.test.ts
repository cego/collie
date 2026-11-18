import * as Option from "effect/Option";
import { pipe as pipe_ } from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Effect, FileSystem } from "effect";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readEnv, type PluginEnv } from "../src/env";
import { defaultsPath, readDefaults } from "../src/intent";
import { executorFor, resetExecutors } from "../src/executors";
import { registerRunExecutors } from "../src/operations";
import { scopeKey } from "../src/registry";
import { listTasks, writeTask } from "../src/task";
import { runEffect } from "./support/effect";

let stateDir: string;
let env: PluginEnv;
let picker: string;

const defaultsOfW1 = Effect.fn("test.defaultsOfW1")(function* () {
  return yield* defaultsPath(stateDir, scopeKey({ session: null, workspaceId: null, cwd: picker }));
});

const carry = (
  action: Parameters<NonNullable<ReturnType<typeof executorFor>>>[0],
  asker: PluginEnv = env,
) =>
  Effect.suspend(() =>
    executorFor(action.kind)!(action, { origin: "cli-tty", requestId: "h-1" }, asker),
  );

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      resetExecutors();
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-executors-" });
      const userDir = `${stateDir}/config`;
      yield* fs.makeDirectory(userDir);
      picker = `${stateDir}/picker`;
      yield* fs.makeDirectory(picker);
      env = readEnv({
        ...process.env,
        COLLIE_STATE_DIR: stateDir,
        COLLIE_ROOT: process.cwd(),
        COLLIE_USER_DIR: userDir,
        COLLIE_CWD: stateDir,
      });
      yield* registerRunExecutors();
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

afterAll(() => {
  resetExecutors();
});

test("a default constraint is written where the workspace's own Runs read it", () =>
  runEffect(
    Effect.gen(function* () {
      const done = yield* carry({
        kind: "update_defaults",
        change: "add-constraint",
        workspace: picker,
        text: "no force pushes",
      });
      expect(done.state).toBe("applied");
      const written = yield* readDefaults(yield* defaultsOfW1());
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(written), (present) =>
            Arr.map(present.constraints, (c) => c.text),
          ),
        ),
      ).toEqual(["no force pushes"]);
      expect(written?.constraints.at(0)?.source).toBe("workspace-default");
    }),
  ));

test("a workspace nobody has is refused, rather than written somewhere else", () =>
  runEffect(
    Effect.gen(function* () {
      const done = yield* carry({
        kind: "update_defaults",
        change: "add-constraint",
        workspace: "not-a-workspace",
        text: "no force pushes",
      });
      expect(done.state).toBe("failed");
      expect(yield* readDefaults(yield* defaultsOfW1())).toBeNull();
    }),
  ));

test("a removal names the constraint's id, and prose removes nothing and says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* carry({
        kind: "update_defaults",
        change: "add-constraint",
        workspace: picker,
        text: "no force pushes",
      });
      const id = (yield* readDefaults(yield* defaultsOfW1()))!.constraints[0]!.id;

      const byProse = yield* carry({
        kind: "update_defaults",
        change: "remove-constraint",
        workspace: picker,
        text: "no force pushes",
      });
      expect(byProse.state).toBe("failed");
      expect((yield* readDefaults(yield* defaultsOfW1()))?.constraints).toHaveLength(1);

      const byId = yield* carry({
        kind: "update_defaults",
        change: "remove-constraint",
        workspace: picker,
        text: id,
      });
      expect(byId.state).toBe("applied");
      expect((yield* readDefaults(yield* defaultsOfW1()))?.constraints).toEqual([]);
    }),
  ));

test("a persona fork writes into the layer it named", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const done = yield* carry({
        kind: "fork_definition",
        what: "persona",
        name: "implementer",
        as: "implementer-ours",
      });
      expect(done.state).toBe("applied");
      const written =
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(done.note), (present__) =>
            pipe_(present__, Str.replace("forked to ", "")),
          ),
        ) ?? "";
      expect(yield* fs.exists(written)).toBe(true);
      expect(written).toContain("implementer-ours");
    }),
  ));

test("a workflow is not forked by copying a file, and says what does fork one", () =>
  runEffect(
    Effect.gen(function* () {
      const done = yield* carry({
        kind: "fork_definition",
        what: "workflow",
        name: "implement",
        as: "implement-ours",
      });
      expect(done.state).toBe("failed");
      expect(done.note).toContain("collie workflow fork");
    }),
  ));

test("a definition that is not there is refused, and writes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const done = yield* carry({
        kind: "fork_definition",
        what: "persona",
        name: "not-a-persona",
        as: "mine",
      });
      expect(done).toEqual({ state: "failed", note: 'No persona "not-a-persona".' });
    }),
  ));

test("a cleanup forgets the closed Tasks no Run belongs to, and keeps the rest", () =>
  runEffect(
    Effect.gen(function* () {
      const at = { label: "t", cwd: stateDir, created_at: "2026-09-28T00:00:00Z", workspace: null };
      yield* writeTask({ ...at, id: "kept" });
      yield* writeTask({ ...at, id: "gone", closed_at: "2026-09-29T00:00:00Z" });
      const done = yield* carry({ kind: "home_cleanup" });
      expect(done.note).toContain("forgot 1 closed Tasks");
      expect(Arr.map(yield* listTasks, (task) => task.id)).toEqual(["kept"]);
    }),
  ));

test("an upgrade that cannot run reports a failure rather than taking the confirmation down", () =>
  runEffect(
    Effect.gen(function* () {
      const done = yield* carry({ kind: "upgrade" }, { ...env, pluginRoot: stateDir });
      expect(done.state).toBe("failed");
      expect(done.note).toContain(stateDir);
    }),
  ));
