// The taxonomy is the contract: what is sent, how it is titled, and how often.

import type { ChildProcessSpawner } from "effect/process";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, type Schema } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import {
  NOTIFICATION_KINDS,
  Notifier,
  notificationTitle,
  openedSubject,
  wanted,
} from "../src/notify";
import { slackApi } from "../src/slack";
import { writeSlackToken } from "../src/slack-credentials";
import { writeConfigValue } from "../src/config";
import { fakeSlack } from "./support/slack";
import { Rig, FakeHerdr } from "./support/recorder";
import { Agents, agentsLayer } from "../src/agents";
import { runEffect } from "./support/effect";
import { Children, Host } from "../src/sdk";
import { foundationLayer, loadEntry } from "../src/engine";
import { Store } from "../src/store";
import { fixtures, until } from "./support/host";
import { writeTask } from "../src/task";

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
const ownRun = Effect.flatMap(Store, (store) =>
  store.admit({
    request: "req-own",
    run: "r-own",
    workflow: "plan",
    project: "/work/collie",
    input: {},
    provenance: {},
    options: {},
    generation: "g",
    execution: "exec-own",
    task: null,
    parent: null,
    placing: '{"from":"/work/collie","taskLabel":null}',
  }),
);

/** One host's lifetime, whose toasts land in `toasts` as `sound|title|body`. */
const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    | WorkflowEngine.WorkflowEngine
    | Agents
    | Children
    | Host
    | Notifier
    | Store
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
  >,
  options: {
    readonly dir?: string;
    readonly slack?: typeof slackApi;
    readonly toast?: import("../src/engine").Toast;
  } = {},
) =>
  run.pipe(
    Effect.provide(
      agentsLayer({
        dir,
        env: rig.pluginEnv(),
        herdr: new FakeHerdr(rig.pluginEnv()),
        harness: "claude",
        model: "opus",
        permissions: "auto",
        compactAtTokens: 0,
      }),
    ),
    Effect.provide(Layer.succeed(Children)(Children.of({ start: nothing, result: nothing }))),
    Effect.provide(
      foundationLayer({
        dir,
        userDir: rig.pluginEnv().userDir,
        toast: (title, body, sound) => Effect.sync(() => toasts.push(`${sound}|${title}|${body}`)),
        placing: { env: rig.pluginEnv(), herdr: new FakeHerdr(rig.pluginEnv()) },
        ...options,
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

test("a Run's toast names the Task it is part of by what it is called, never by its id", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeTask(dir, {
        id: "task-7",
        workspace: "w7",
        label: "Collie | Offer banner fix",
        cwd: dir,
        created_at: "2026-10-28T09:00:00Z",
      });
      yield* session(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.admit({
            request: "req-r1",
            run: "r1",
            workflow: "implement",
            project: dir,
            input: {},
            provenance: {},
            options: {},
            generation: "g",
            execution: "exec-r1",
            task: "task-7",
            parent: null,
            placing: `{"from":"${dir}","taskLabel":null}`,
          });
          yield* (yield* Host).mergeRequest(
            "r1",
            "https://gitlab.example/acme/app/-/merge_requests/42",
          );
        }),
      );
      expect(toasts).toEqual([
        "done|host · Offer banner fix opened !42|https://gitlab.example/acme/app/-/merge_requests/42",
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

test("an opened merge request's notification names it as its forge does", () => {
  expect(openedSubject("https://github.com/cego/collie/pull/30")).toBe("#30");
  expect(openedSubject("https://gitlab.cego.dk/cego/collie/-/merge_requests/42")).toBe("!42");
  expect(openedSubject("https://example.com/nothing")).toBeUndefined();
});

test("two hosts send a needs-you event once from its owning host without Desktop, and skip disabled kinds", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const other = `${rig.root}/other-host`;
      yield* fs.makeDirectory(other);
      yield* writeSlackToken(rig.pluginEnv(), "xoxb-fixture");
      yield* writeConfigValue(rig.userDir, "slack.notification_channel", "C123");
      yield* writeConfigValue(rig.userDir, "notifications.run-done", false);
      const owner = fakeSlack();
      const peer = fakeSlack();
      const notify = Effect.gen(function* () {
        const notifier = yield* Notifier;
        yield* Effect.all(
          [
            notifier.notify("r-own", "needs-you", "Choose the approach", { key: "approach" }),
            notifier.notify("r-own", "needs-you", "Choose the approach", { key: "approach" }),
          ],
          { concurrency: "unbounded" },
        );
        yield* notifier.notify("r-own", "run-done", "Finished");
      });
      const own = { slack: (token: string) => slackApi(token, owner.client), toast: undefined };
      yield* session(
        Effect.gen(function* () {
          yield* ownRun;
          yield* notify;
        }),
        own,
      );
      yield* session(notify, own);
      yield* session(notify, {
        dir: other,
        slack: (token) => slackApi(token, peer.client),
        toast: undefined,
      });
      expect(owner.calls.filter((call) => call.method === "chat.postMessage")).toEqual([
        {
          method: "chat.postMessage",
          parameters: { channel: "C123", text: "collie · r-own needs you\nChoose the approach" },
        },
      ]);
      expect(peer.calls).toEqual([]);
      expect(toasts).toEqual([]);
    }),
  ));

test("a notification for a person opens the DM and posts only in the returned channel", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeSlackToken(rig.pluginEnv(), "xoxb-fixture");
      yield* writeConfigValue(rig.userDir, "slack.notification_channel", "U789");
      const slack = fakeSlack();
      yield* session(
        Effect.gen(function* () {
          yield* ownRun;
          yield* (yield* Notifier).notify("r-own", "needs-you", "Choose the approach");
        }),
        { slack: (token) => slackApi(token, slack.client), toast: undefined },
      );
      expect(slack.calls.filter((call) => call.method !== "auth.test")).toEqual([
        { method: "conversations.open", parameters: { users: "U789" } },
        {
          method: "chat.postMessage",
          parameters: { channel: "D123", text: "collie · r-own needs you\nChoose the approach" },
        },
      ]);
    }),
  ));

test("notification text cannot turn a Run's words into Slack mentions", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeSlackToken(rig.pluginEnv(), "xoxb-fixture");
      yield* writeConfigValue(rig.userDir, "slack.notification_channel", "C123");
      const slack = fakeSlack();
      yield* session(
        Effect.gen(function* () {
          yield* ownRun;
          yield* (yield* Notifier).notify("r-own", "needs-you", "Choose <@U789> & <!channel>");
        }),
        { slack: (token) => slackApi(token, slack.client) },
      );
      expect(slack.calls.find((call) => call.method === "chat.postMessage")?.parameters.text).toBe(
        "collie · r-own needs you\nChoose &lt;@U789&gt; &amp; &lt;!channel&gt;",
      );
      expect(toasts).toEqual(["request|collie · r-own needs you|Choose <@U789> & <!channel>"]);
    }),
  ));
