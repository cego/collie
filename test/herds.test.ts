// The herdr sessions a host reads, and what tells it that one of them changed.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Duration, Effect, Option, Stream } from "effect";
import { Herdr } from "../src/herdr";
import { agentsIn, focusPane, herdChanges } from "../src/herds";
import { newTask, readTask, writeTask } from "../src/task";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      delete Bun.env.FAKE_HERDR_PUSH_EVENT;
      yield* rig.close();
    }),
  ),
);

const changeAfter = (wait: Duration.Input) =>
  Effect.gen(function* () {
    const env = rig.pluginEnv();
    const herdr = new Herdr(env);
    yield* herdr.cli(["agent", "start", "impl-1", "--pane", "1-1"]);
    return yield* herdChanges(herdr, env).pipe(Stream.runHead, Effect.timeoutOption(wait));
  });

test("a change is what herdr pushes on the session's subscription, for each agent's pane", () =>
  runEffect(
    Effect.gen(function* () {
      Bun.env.FAKE_HERDR_PUSH_EVENT = "1";
      expect(Option.isSome(yield* changeAfter("10 seconds"))).toBe(true);

      const subscribed = Option.getOrUndefined(
        Arr.findFirst(yield* rig.calls(), (call) => call.cmd === "events.subscribe"),
      );
      expect(subscribed?.params).toEqual({
        subscriptions: [
          { type: "pane.created" },
          { type: "pane.closed" },
          { type: "pane.agent_detected" },
          { type: "pane.agent_status_changed", pane_id: "1-1" },
        ],
      });
    }),
  ));

test("a pane herdr restored on a session but with no name is watched, and its status read", () =>
  runEffect(
    Effect.gen(function* () {
      Bun.env.FAKE_HERDR_PUSH_EVENT = "1";
      yield* rig.addRestored({
        paneId: "wT-p9",
        workspaceId: "wT",
        terminalId: "t-restored",
        session: { kind: "pi", value: "/home/mk/.pi/sessions/impl.jsonl" },
        status: "working",
      });
      yield* rig.addRestored({
        paneId: "wT-p8",
        workspaceId: "wT",
        terminalId: "t-shell",
        session: null,
      });
      expect(Option.isSome(yield* changeAfter("10 seconds"))).toBe(true);

      const subscribed = Option.getOrUndefined(
        Arr.findFirst(yield* rig.calls(), (call) => call.cmd === "events.subscribe"),
      );
      expect(subscribed?.params).toEqual({
        subscriptions: [
          { type: "pane.created" },
          { type: "pane.closed" },
          { type: "pane.agent_detected" },
          { type: "pane.agent_status_changed", pane_id: "1-1" },
          { type: "pane.agent_status_changed", pane_id: "wT-p9" },
        ],
      });
      const herdr = new Herdr(rig.pluginEnv());
      expect((yield* agentsIn([{ herd: null, herdr }])).restored).toEqual([
        { terminalId: "t-restored", status: "working" },
      ]);
    }),
  ));

test("a session's named agents and restored panes are read with one agent list", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addRestored({
        paneId: "wT-p9",
        workspaceId: "wT",
        terminalId: "t-restored",
        session: { kind: "pi", value: "/home/mk/.pi/sessions/impl.jsonl" },
        status: "idle",
      });
      const herdr = new Herdr(rig.pluginEnv());
      yield* herdr.cli(["agent", "start", "impl-1", "--pane", "1-1"]);
      const before = (yield* rig.cmds()).length;
      const read = yield* agentsIn([{ herd: null, herdr }]);
      expect(Arr.map(read.alive, (agent) => agent.paneId)).toContain("1-1");
      expect(read.restored).toEqual([{ terminalId: "t-restored", status: "idle" }]);
      expect((yield* rig.cmds()).slice(before).sort()).toEqual(["agent list", "pane list"]);
    }),
  ));

test("a session whose socket does not answer is not listed for a subscription it cannot make", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), socketPath: `${rig.stateDir}/gone.sock` };
      const herdr = new Herdr(env);
      yield* herdr.cli(["agent", "start", "impl-1", "--pane", "1-1"]);
      const before = (yield* rig.cmds()).length;
      yield* herdChanges(herdr, env).pipe(Stream.runHead, Effect.timeoutOption("1 second"));
      expect(
        Arr.filter(
          (yield* rig.cmds()).slice(before),
          (cmd) => cmd === "agent list" || cmd === "pane list",
        ),
      ).toEqual([]);
    }),
  ));

test("a session herdr says nothing about is not a change", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* changeAfter("1 second")).toEqual(Option.none());
    }),
  ));

test("a new Task records its Herd, and one recorded before the field still loads", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* newTask({ workspace: "w1", label: "a | b", cwd: "/p", herd: "herd-1" });
      yield* writeTask(rig.stateDir, task);
      expect((yield* readTask(rig.stateDir, task.id))?.herd).toBe("herd-1");

      const { herd: _, ...older } = { ...task, id: "task-old" };
      yield* writeTask(rig.stateDir, older);
      const read = yield* readTask(rig.stateDir, "task-old");
      expect(read?.label).toBe("a | b");
      expect(read?.herd).toBeUndefined();
    }),
  ));

test(
  "a Run's pane is focused where its newest live agent is, and said as herdr labels it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const herdr = new Herdr(rig.pluginEnv());
        yield* rig.addWorkspace("1", "workspace 3", "/p");
        const { paneId } = yield* rig.addTab("tab 2", "impl");
        yield* rig.addAgent("impl-1", paneId);
        const sessions = [{ herd: null, name: "work", default: false, herdr }];

        expect(yield* focusPane(sessions, ["impl-2", "impl-1"], null, null)).toEqual({
          session: "work",
          workspace: "workspace 3",
          tab: "tab 2",
          pane: paneId,
          agent: "impl-1",
        });
        expect(Arr.filter(yield* rig.cmds(), (cmd) => pipe_(cmd, Str.includes("focus")))).toEqual([
          "agent focus",
        ]);

        // herdr's default session is the one a client attaches to without naming one.
        const inDefault = yield* focusPane(
          [{ ...sessions[0]!, default: true }],
          ["impl-1"],
          null,
          null,
        );
        expect(inDefault?.session).toBeNull();
      }),
    ),
  30_000,
);

test(
  "the one agent asked for is focused and named, and one herdr no longer has is its workspace",
  () =>
    runEffect(
      Effect.gen(function* () {
        const herdr = new Herdr(rig.pluginEnv());
        yield* rig.addWorkspace("1", "workspace 1", "/p");
        const { paneId: implPane } = yield* rig.addTab("tab 1", "impl");
        yield* rig.addAgent("impl-1", implPane);
        const { paneId: reviewPane } = yield* rig.addTab("tab 2", "review");
        yield* rig.addAgent("review-1", reviewPane);
        const sessions = [{ herd: null, name: "default", default: true, herdr }];

        expect(yield* focusPane(sessions, ["review-1"], "1", null)).toEqual({
          session: null,
          workspace: "workspace 1",
          tab: "tab 2",
          pane: reviewPane,
          agent: "review-1",
        });
        const gone = yield* focusPane(sessions, ["review-2"], "1", null);
        expect(gone).toEqual({ session: null, workspace: "workspace 1", tab: null });
      }),
    ),
  30_000,
);

test(
  "a Run with no live agent is focused as its workspace, and one with neither is nowhere",
  () =>
    runEffect(
      Effect.gen(function* () {
        const herdr = new Herdr(rig.pluginEnv());
        yield* rig.addWorkspace("w7", "workspace 7", "/p");
        const sessions = [{ herd: null, name: "default", default: true, herdr }];

        expect(yield* focusPane(sessions, ["impl-1"], "w7", null)).toEqual({
          session: null,
          workspace: "workspace 7",
          tab: null,
        });
        expect(Arr.filter(yield* rig.cmds(), (cmd) => pipe_(cmd, Str.includes("focus")))).toEqual([
          "workspace.focus",
        ]);
        expect(yield* focusPane(sessions, ["impl-1"], "w7", null)).not.toHaveProperty("pane");
        expect(yield* focusPane(sessions, ["impl-1"], "w-gone", null)).toBeNull();
      }),
    ),
  30_000,
);

test(
  "a Run's workspace is looked for only in its own Herd, where workspace ids are its own",
  () =>
    runEffect(
      Effect.gen(function* () {
        const herdr = new Herdr(rig.pluginEnv());
        yield* rig.addWorkspace("w7", "someone else's", "/p");
        const theirs = { herd: "theirs", name: "theirs", default: false, herdr };

        expect(yield* focusPane([theirs], ["impl-1"], "w7", "mine")).toBeNull();
        // A Task from before Herds were recorded falls back only where there is no other Herd.
        expect(
          yield* focusPane([theirs, { ...theirs, herd: "x" }], [], "w7", undefined),
        ).toBeNull();
        expect(Arr.filter(yield* rig.cmds(), (cmd) => pipe_(cmd, Str.includes("focus")))).toEqual(
          [],
        );
        expect((yield* focusPane([theirs], [], "w7", undefined))?.workspace).toBe("someone else's");
      }),
    ),
  30_000,
);
