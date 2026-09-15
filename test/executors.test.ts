// What confirming an installation-wide proposal actually does.
//
// These four kinds are the ones that are not about a Run — a fork, a change to what a
// workspace's new Runs begin with, a cleanup, an upgrade — so nothing about a Run's
// record says whether they worked. The file that was written and the panes that were
// asked to close are what says it, and that is what is asserted here.
//
// The failure this is built against: an executor that writes a real file under the wrong
// key, reports `applied` with the new contents, and is believed. A defaults file is read
// by a Run under the workspace it was started in, and the board that carries out a
// confirmation is in the Home — so "it wrote a defaults file" and "a Run will read it"
// are two different facts.

import { Effect, FileSystem, Path, Schema } from "effect";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readEnv, type PluginEnv } from "../src/env";
import { defaultsPath, readDefaults } from "../src/intent";
import { executorFor, resetExecutors } from "../src/executors";
import { LEGACY_PANE_TOKEN } from "../src/home";
import { registerRunExecutors } from "../src/operations";
import { scopeKey } from "../src/registry";
import { runEffect } from "./support/effect";

let stateDir: string;
let env: PluginEnv;
let logPath: string;

/** What the fake herdr reads back as its own state, and as the metadata on each pane. */
const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Any));

/** The workspace the fake herdr has, and the one every action below names. */
const WORKSPACE = { workspace_id: "w1", label: "picker", cwd: "" };

const fakeHerdrOn = Effect.fn("test.fakeHerdrOn")(function* (
  root: string,
  panes: ReadonlyArray<{ pane_id: string; tab_id: string; label: string | null }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binPath = path.join(root, "herdr");
  const fake = path.join(process.cwd(), "test", "support", "fake-herdr.ts");
  yield* fs.writeFileString(binPath, `#!/bin/sh\nexec bun ${fake} "$@"\n`, { mode: 0o755 });
  logPath = path.join(root, "fake.log");
  yield* fs.writeFileString(
    `${logPath}.state.json`,
    asJson({ workspaces: [{ ...WORKSPACE, cwd: root }], paneList: panes }),
  );
  // What a `*.report_metadata` left on each pane, which is how `closable` tells a legacy
  // per-workspace Collie pane from any other pane in the same tab.
  yield* fs.writeFileString(
    `${logPath}.tokens.json`,
    asJson({
      workspaces: {},
      panes: Object.fromEntries(
        panes
          .filter((pane) => pane.label === "collie")
          .map((pane) => [pane.pane_id, { [LEGACY_PANE_TOKEN]: "legacy" }]),
      ),
    }),
  );
  return binPath;
});

/** Where a Run started in `w1` reads its defaults, which is the only file that counts. */
const defaultsOfW1 = Effect.fn("test.defaultsOfW1")(function* () {
  return yield* defaultsPath(
    stateDir,
    scopeKey({ session: env.socketPath, workspaceId: "w1", cwd: stateDir }),
  );
});

const carry = (action: Parameters<NonNullable<ReturnType<typeof executorFor>>>[0]) =>
  Effect.suspend(() => executorFor(action.kind)!(action, "cli-tty:h-1"));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Executors register once per process and close over the registering caller's
      // state directory, so the registry is emptied with it.
      resetExecutors();
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-executors-" });
      // The baseline layer is the repository's own definitions, so there is a Workflow to
      // fork; the user layer is a temp directory, so forking one writes nowhere real.
      const configDir = yield* fs.makeTempDirectory({ prefix: "hw-executors-config-" });
      const binPath = yield* fakeHerdrOn(stateDir, [
        { pane_id: "p-collie", tab_id: "t-1", label: "collie" },
        { pane_id: "p-shared", tab_id: "t-2", label: "collie" },
        { pane_id: "p-other", tab_id: "t-2", label: "an editor" },
      ]);
      env = readEnv({
        ...process.env,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_SOCKET_PATH: `${stateDir}/herd.sock`,
        HERDR_BIN_PATH: binPath,
        HERDR_PLUGIN_ROOT: process.cwd(),
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        COLLIE_CWD: stateDir,
        FAKE_HERDR_LOG: logPath,
      });
      yield* registerRunExecutors(env);
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

// And once the file is done, because the registry is the process's: left registered, the
// next file's confirmations run against these executors and the temp directory they
// closed over, which `afterEach` has already deleted.
afterAll(() => {
  resetExecutors();
});

test("a default constraint is written where the workspace's own Runs read it", () =>
  runEffect(
    Effect.gen(function* () {
      const done = yield* carry({
        kind: "update_defaults",
        change: "add-constraint",
        workspace: "w1",
        text: "no force pushes",
      });
      expect(done.state).toBe("applied");
      // Under the named workspace's key, which is where a Run started there looks — not
      // under the board's own, which is the Home's and which no Run ever opens.
      const written = yield* readDefaults(yield* defaultsOfW1());
      expect(written?.constraints.map((c) => c.text)).toEqual(["no force pushes"]);
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
        workspace: "w1",
        text: "no force pushes",
      });
      const id = (yield* readDefaults(yield* defaultsOfW1()))!.constraints[0]!.id;

      // Ids are a hash of the text, so the words never match one. Reporting that as
      // applied would tell the human a standing constraint was dropped that is still
      // there, which is the whole reason this refuses.
      const byProse = yield* carry({
        kind: "update_defaults",
        change: "remove-constraint",
        workspace: "w1",
        text: "no force pushes",
      });
      expect(byProse.state).toBe("failed");
      expect((yield* readDefaults(yield* defaultsOfW1()))?.constraints).toHaveLength(1);

      const byId = yield* carry({
        kind: "update_defaults",
        change: "remove-constraint",
        workspace: "w1",
        text: id,
      });
      expect(byId.state).toBe("applied");
      expect((yield* readDefaults(yield* defaultsOfW1()))?.constraints).toEqual([]);
    }),
  ));

test("a fork writes the definition into the layer it named", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const done = yield* carry({
        kind: "fork_definition",
        what: "workflow",
        name: "implement",
        as: "implement-ours",
      });
      expect(done.state).toBe("applied");
      const written = done.note?.replace("forked to ", "") ?? "";
      expect(yield* fs.exists(written)).toBe(true);
      expect(written).toContain("implement-ours");
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

test("a cleanup closes the panes that are Collie's alone, and leaves the shared tab", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const done = yield* carry({ kind: "home_cleanup" });
      expect(done.state).toBe("applied");
      // Taking somebody's window away is not cleanup: the pane sharing a tab with an
      // editor is listed, never closed.
      const log = yield* fs
        .readFileString(logPath, "utf8")
        .pipe(Effect.catch(() => Effect.succeed("")));
      expect(log).toContain("p-collie");
      expect(log).not.toContain("p-other");
      expect(done.note).toContain("left 1 sharing a tab");
    }),
  ));

test("an upgrade that cannot run reports a failure rather than taking the confirmation down", () =>
  runEffect(
    Effect.gen(function* () {
      // Its own plugin root, empty: no checkout to pull and no `prepare.sh` to run, so
      // this asks nothing of the network and of nobody's repository. A confirmation
      // carrying out a sequence has to be told the step failed, not die inside it.
      resetExecutors();
      yield* registerRunExecutors({ ...env, pluginRoot: stateDir });
      const done = yield* carry({ kind: "upgrade" });
      expect(done.state).toBe("failed");
      expect(done.note).toContain(stateDir);
    }),
  ));
