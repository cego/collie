// The taxonomy is the contract: what is sent, how it is titled, and how often.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, type Schema } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { NOTIFICATION_KINDS, notificationTitle, wanted } from "../src/notify";
import { Rig, FakeHerdr } from "./support/recorder";
import { Agents, agentsLayer } from "../src/agents";
import { runEffect } from "./support/effect";
import { Children, Host } from "../src/sdk";
import { foundationLayer, loadEntry } from "../src/engine";
import { Store } from "../src/store";
import { fixtures, until } from "./support/host";

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
  expect(notificationTitle("mr-opened", "/x/repo", "s", "!42")).toBe("repo · s opened !42");
});

test("a kind turned off in settings is not sent, and everything else is", () => {
  expect(wanted({}, "run-done")).toBe(true);
  expect(wanted({ "run-done": true }, "run-done")).toBe(true);
  expect(wanted({ "run-done": false }, "run-done")).toBe(false);
  expect(wanted({ "run-done": false }, "needs-you")).toBe(true);
});

let rig: Rig;
let dir: string;
let toasts: string[];

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      dir = `${rig.root}/host`;
      toasts = [];
      yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const nothing = () => Effect.die("no children here");

/** One host's lifetime, whose toasts land in `toasts` as `sound|title|body`. */
const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    | WorkflowEngine.WorkflowEngine
    | Agents
    | Children
    | Host
    | Store
    | FileSystem.FileSystem
    | Path.Path
  >,
) =>
  run.pipe(
    Effect.provide(
      agentsLayer({
        dir,
        env: rig.pluginEnv(),
        herdr: new FakeHerdr(rig.pluginEnv()),
        harness: "claude",
        model: "opus",
        permissions: "bypass",
        compactAtTokens: 0,
      }),
    ),
    Effect.provide(Layer.succeed(Children)(Children.of({ start: nothing, result: nothing }))),
    Effect.provide(
      foundationLayer({
        dir,
        userDir: rig.pluginEnv().userDir,
        toast: (title, body, sound) => Effect.sync(() => toasts.push(`${sound}|${title}|${body}`)),
      }),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const executed = (entry: string, runId: string, input: Readonly<Record<string, Schema.Json>>) =>
  session(
    Effect.gen(function* () {
      const described = yield* loadEntry(`${fixtures}/${entry}`).pipe(Effect.orDie);
      const made = described.make(`${described.id}@${runId}`);
      return yield* made.workflow
        .execute({ runId, input })
        .pipe(Effect.result, Effect.provide(made.layer));
    }),
  );

/** Work that parks on its question, submitted and then waited on until it is asking. */
const asking = (runId: string) =>
  session(
    Effect.gen(function* () {
      const described = yield* loadEntry(`${fixtures}/branches.workflow.ts`).pipe(Effect.orDie);
      const made = described.make(`${described.id}@${runId}`);
      const store = yield* Store;
      yield* Effect.gen(function* () {
        yield* made.workflow.execute({ runId, input: { size: "big" } }, { discard: true });
        yield* until(
          () => store.asked(runId),
          (rows) => rows.length > 0,
        );
      }).pipe(Effect.provide(made.layer));
    }),
  );

test("a Run that finishes says so once, and one that fails says why", () =>
  runEffect(
    Effect.gen(function* () {
      yield* executed("hello.workflow.ts", "r1", { name: "you" });
      expect(toasts).toEqual(["done|host · r1 finished|hello you, from hello"]);

      yield* executed("declines.workflow.ts", "r2", {});
      expect(toasts.slice(1)).toHaveLength(1);
      expect(toasts[1]).toStartWith("request|host · r2 failed|");
      expect(toasts[1]).toContain("too big to take on");
    }),
  ));

test("a question says the Run needs you, once however often the work reaches it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* asking("r1");
      yield* asking("r1");
      // Parked, not finished: a suspension is not an ending.
      expect(toasts).toEqual(["request|host · r1 needs you|approach: How should we tackle this?"]);
    }),
  ));

test("a merge request recorded says it was opened, naming it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* session(
        Effect.gen(function* () {
          const host = yield* Host;
          yield* host.mergeRequest("r1", "https://gitlab.example/acme/app/-/merge_requests/42");
        }),
      );
      expect(toasts).toEqual([
        "done|host · r1 opened !42|https://gitlab.example/acme/app/-/merge_requests/42",
      ]);
    }),
  ));

test("a kind the operator turned off is not sent", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = rig.pluginEnv().userDir;
      yield* fs.makeDirectory(config, { recursive: true });
      yield* fs.writeFileString(`${config}/config.json`, `{"notifications":{"run-done":false}}`);
      yield* executed("hello.workflow.ts", "r1", { name: "you" });
      expect(toasts).toEqual([]);
    }),
  ));
