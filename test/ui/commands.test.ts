import * as Rec from "effect/Record";
import * as Str from "effect/String";
import type { PlatformServices } from "../../src/platform";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, PlatformError, type Scope } from "effect";
import { Rig, type RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { installFakeSkills } from "../support/defs";
import { FakeBin, gitWorktreeCases } from "../support/bin";
import { runEffect } from "../support/effect";
import { runCommand } from "../../src/flows";
import type { Jump } from "../../src/ui/state";
import { Herdr } from "../../src/herdr";
import { registerAgent, scopeFor } from "../../src/registry";
import { loadDefaults, readConfig, readSettingsSet } from "../../src/config";
import type { RunFacts } from "../../src/runs";
import { openHost } from "../support/host";
import { madeRun, recordsAt } from "../support/records";
import { Path, FileSystem } from "effect";
import { stringifyJson } from "../../src/json";

let rig: Rig;
let bin: FakeBin;
let runs: RunFacts[] = [];

function effectTest(
  name: string,
  body: () => Effect.gen.Return<
    void,
    RigError | PlatformError.PlatformError | Error,
    PlatformServices | Scope.Scope
  >,
) {
  test(name, () => runEffect(Effect.gen(body)));
}

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      runs = [];
      yield* installBaseline(rig);
      yield* installFakeSkills(rig.root);
      bin = yield* FakeBin.make(`${rig.root}/bin`);
      yield* bin.add("stub-driver", "exit 0");
      yield* bin.add(
        "git",
        `case "$*" in
      "rev-parse --abbrev-ref HEAD") echo feature ;;
      "symbolic-ref --short refs/remotes/origin/HEAD") echo origin/master ;;
${gitWorktreeCases(rig.projectDir)}
      *) exit 1 ;;
    esac`,
      );
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

function session() {
  const env = rig.pluginEnv();
  return {
    herdr: new Herdr(env),
    ...scopeFor(env.cwd),
    stateDir: env.stateDir,
    userDir: env.userDir,
    pluginRoot: env.pluginRoot,
    runsOf: () => Effect.succeed(runs),
  };
}

const prompts = {
  menu: () => Effect.succeed(null),
  ask: () => Effect.succeed(null),
};

const set = (key: string, value: string) =>
  runCommand(session(), rig.pluginEnv(), { _tag: "SetDefault", key, value }, prompts);

effectTest("clearing a default unsets it rather than configuring an empty one", function* () {
  yield* set("harness", "codex");

  const note = yield* set("harness", "");

  expect(note).toContain("unset");
  expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("harness");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).harness).toBe("claude");
});

effectTest(
  "gitlab_host is refused unless it is a host name, and defaults to gitlab.cego.dk",
  function* () {
    expect((yield* loadDefaults(rig.pluginEnv().userDir)).gitlabHost).toBe("gitlab.cego.dk");

    expect(yield* set("gitlab_host", "https://gitlab.com/")).toContain("host name");
    expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("gitlab_host");

    expect(yield* set("gitlab_host", "gitlab.com")).toContain("gitlab.com");
    expect((yield* loadDefaults(rig.pluginEnv().userDir)).gitlabHost).toBe("gitlab.com");
  },
);

effectTest(
  "permissions is refused unless it is a mode a Run can start an agent with",
  function* () {
    const note = yield* set("permissions", "yolo");

    expect(note).toContain("auto, bypass, harness");
    expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("permissions");
    expect(yield* set("permissions", "harness")).toContain("harness");
    expect((yield* loadDefaults(rig.pluginEnv().userDir)).permissions).toBe("harness");
  },
);

effectTest("scope is refused unless it is a board the tab can open on", function* () {
  const note = yield* set("scope", "everything");

  expect(note).toContain("local, all");
  expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("scope");
  expect(yield* set("scope", "all")).toContain("all");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).scope).toBe("all");
});

effectTest(
  "Claude Code's auto-compact window is 400000 until set, and is stored as written",
  function* () {
    const userDir = rig.pluginEnv().userDir;
    expect((yield* loadDefaults(userDir)).claudeAutoCompactWindow).toBe(400000);

    expect(yield* set("claude_auto_compact_window", "2000000")).toContain(
      "from 100000 to 1000000, or auto",
    );
    expect(yield* readConfig(userDir)).not.toHaveProperty("claude_auto_compact_window");

    yield* set("claude_auto_compact_window", "500000");
    expect((yield* readConfig(userDir)).claude_auto_compact_window).toBe(500000);
    yield* set("claude_auto_compact_window", "auto");
    expect((yield* loadDefaults(userDir)).claudeAutoCompactWindow).toBe("auto");

    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${userDir}/config.json`, `{ "claude_auto_compact_window": 50000 }`);
    expect((yield* loadDefaults(userDir)).claudeAutoCompactWindow).toBe(50000);
  },
);

effectTest("a default is written without the whitespace around it", function* () {
  const note = yield* set("harness", "  codex  ");

  expect(note).toBe("harness is now codex");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).harness).toBe("codex");
});

effectTest("a setting records when it was set, and proactive is one", function* () {
  const userDir = rig.pluginEnv().userDir;

  expect(yield* set("proactive", "false")).toBe("proactive is now false");

  expect((yield* loadDefaults(userDir)).proactive).toBe(false);
  expect(Rec.keys((yield* readSettingsSet(userDir)).set)).toEqual(["proactive"]);
  expect(yield* set("models.claude", "claude-x, claude-y")).toContain("claude-x, claude-y");
  expect((yield* loadDefaults(userDir)).models).toEqual({ claude: ["claude-x", "claude-y"] });
  expect(yield* set("linear.team", "CEG")).toContain("not one of Collie's settings");
});

const elsewhere = Effect.fn("commands.elsewhere")(function* (opts: {
  workspaceId: string;
  status?: "running" | "done";
  target?: string;
  cwd?: string;
}) {
  const env = rig.pluginEnv();
  const run = yield* madeRun(env.stateDir, {
    id: `implement-glass-${runs.length + 1}`,
    cwd: opts.cwd ?? env.cwd,
    workspace: opts.workspaceId,
    state: opts.status === "done" ? "succeeded" : "running",
    settled: { inputs: opts.target ? { target: opts.target } : {}, strategies: {} },
  });
  runs = [run, ...runs];
  yield* registerAgent(scopeFor(run.cwd), {
    role: "implementer",
    agent: "impl-9",
    paneId: "w9:p1",
    workspaceId: opts.workspaceId,
    runId: run.id,
    workflow: run.workflow,
    at: "2026-09-14T10:00:00Z",
  }).pipe(Effect.provide(recordsAt(env.stateDir)));
  return run;
});

const jump = (jump: Jump) =>
  runCommand(session(), rig.pluginEnv(), { _tag: "Jump", jump }, prompts);

effectTest(
  "Enter says how to attach to the agent a row points to, and asks core nothing",
  function* () {
    const run = yield* elsewhere({ workspaceId: "w9" });
    yield* openHost(rig.stateDir);

    expect(yield* jump({ kind: "workspace", workspaceId: "w9", label: "Implement · glass" })).toBe(
      "Implement · glass — nothing to jump to",
    );
    expect(yield* jump({ kind: "run", runId: run.id, label: "Implement · glass" })).toBe(
      "attach to impl-9 with: hc attach impl-9",
    );
    expect(yield* jump({ kind: "agent", agent: "impl-9", label: "Implementer" })).toBe(
      "attach to impl-9 with: hc attach impl-9",
    );
    expect(yield* rig.cmds()).toEqual([]);
  },
);

effectTest("Enter on an Elsewhere row says so and asks core nothing", function* () {
  const note = yield* jump({ kind: "none", label: "Elsewhere · collie-mr-roles-wt" });

  expect(note).toContain("nothing to jump to");
  expect(yield* rig.cmds()).toEqual([]);
});

effectTest("w on another workspace's run opens its merge request, not this repo's", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = path.join(rig.root, "another-checkout");
  yield* fs.makeDirectory(checkout, { recursive: true });
  const run = yield* elsewhere({ workspaceId: "w9", target: "mr:42", cwd: checkout });
  const marker = path.join(rig.root, "glab-cwd.txt");
  yield* bin.add("glab", `pwd > ${stringifyJson(marker)}`);

  const note = yield* runCommand(
    session(),
    rig.pluginEnv(),
    { _tag: "OpenMr", target: "mr:42", runId: run.id },
    prompts,
  );

  expect(note).toContain("opened");
  expect(Str.trim(yield* fs.readFileString(marker))).toBe(checkout);
});

effectTest("questions is refused unless it is a way of presenting one", function* () {
  const note = yield* set("questions", "shout");

  expect(note).toContain("focus, notify");
  expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("questions");
  expect(yield* set("questions", "notify")).toContain("notify");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).questions).toBe("notify");
});

effectTest(
  "Open check output says how to follow the Run's check, and asks core nothing",
  function* () {
    const run = yield* madeRun(rig.pluginEnv().stateDir, {
      id: "r-check",
      workspace: "w7",
      cwd: rig.projectDir,
    });
    runs = [run];

    const note = yield* runCommand(
      session(),
      rig.pluginEnv(),
      { _tag: "OpenCheckOutput", runId: run.id },
      prompts,
    );

    expect(note).toBe("follow its check with: collie run checks r-check --follow");
    expect(yield* rig.cmds()).toEqual([]);
  },
);
