// The host's door: what it answers itself while the engine answers nothing, and what it
// passes on to the engine.

import { expect, test } from "bun:test";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Arr from "effect/Array";
import { Deferred, Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { IdentityRpc, type RunDetail } from "../src/board-model";
import { door, relatedOf, type FromDoor, type ToDoor } from "../src/door";
import { readEnv } from "../src/env";
import { frontDoor } from "../src/host";
import type { RunFacts } from "../src/runs";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

const identity = { build: "test", pid: 1, dir: "/state", protocol: 1, installation: "i" };

/** A door over `dir` whose engine hears everything and answers nothing. */
const silentEngine = (dir: string, socket: string, runs: ReadonlyArray<RunFacts>) =>
  Effect.gen(function* () {
    const heard: Array<FromDoor> = [];
    const listening = yield* Deferred.make<void>();
    let tell: (message: ToDoor) => void = () => {};
    yield* Effect.forkScoped(
      door({
        post: (message) => {
          heard.push(message);
          if (message._tag === "Listening") Deferred.doneUnsafe(listening, Effect.void);
        },
        listen: (receive) => {
          tell = receive;
        },
      }),
    );
    yield* Effect.yieldNow;
    tell({
      _tag: "Open",
      socket,
      env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }),
      identity,
      model: { counter: new SharedArrayBuffer(4), epoch: "e", installation: "i" },
    });
    tell({
      _tag: "Listed",
      runs: Arr.map(runs, (fact) => ({ fact, seq: 0, offers: [] })),
      gone: [],
      order: Arr.map(runs, (fact) => fact.id),
      alive: [],
    });
    yield* Deferred.await(listening);
    return heard;
  });

test("the door answers a Run's record and the host's identity while the engine answers nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-door-" });
      const run = yield* madeRun(dir, {
        id: "r1",
        state: "succeeded",
        created: "2026-10-30T09:00:00Z",
        finished: "2026-10-30T09:30:00Z",
      });
      const socket = `${dir}/host.sock`;
      const heard = yield* silentEngine(dir, socket, [run]);

      const client = yield* frontDoor(socket);
      const first = yield* client
        .runDetail({ runId: "r1", tail: false, pages: 1, refreshMr: false, parts: true })
        .pipe(Stream.runHead, Effect.timeout("5 seconds"));
      expect(first._tag).toBe("Some");
      // SAFETY: a record of a Run the door was told of is a record, not null or Unchanged.
      expect((first._tag === "Some" ? (first.value as RunDetail) : null)?.id).toBe("r1");

      // A Run with no merge request has nothing to ask the engine for any part.
      const whole = yield* client
        .runDetail({ runId: "r1", tail: true, pages: 1, refreshMr: false, parts: true })
        .pipe(
          Stream.filter(
            (frame) => frame !== null && "pending" in frame && frame.pending?.length === 0,
          ),
          Stream.runHead,
          Effect.timeout("5 seconds"),
        );
      expect(whole._tag).toBe("Some");

      const who = yield* RpcClient.make(RpcGroup.make(IdentityRpc)).pipe(
        Effect.provideContext(
          yield* Layer.build(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide(BunSocket.layerNet({ path: socket })),
              Layer.provide(RpcSerialization.layerNdjson),
            ),
          ),
        ),
      );
      expect(yield* who.identity().pipe(Effect.timeout("5 seconds"))).toEqual(identity);

      const toasts = yield* Effect.forkScoped(Stream.runDrain(client.toasts()));
      yield* Effect.gen(function* () {
        while (!Arr.some(heard, (one) => one._tag === "Request" && one.frame._tag === "Request"))
          yield* Effect.sleep("10 millis");
      }).pipe(Effect.timeout("5 seconds"));
      const passed = Arr.flatMap(heard, (one) =>
        one._tag === "Request" && one.frame._tag === "Request" ? [one.frame.tag] : [],
      );
      expect(passed).toEqual(["toasts"]);
      yield* Fiber.interrupt(toasts);
    }).pipe(Effect.scoped),
  ));

test("the door reads the Runs of a record as the engine chooses them, and none it was not told of", () => {
  const fact = (id: string, over: Partial<RunFacts> = {}) =>
    // SAFETY: only the fields `relatedOf` reads are given.
    ({ id, task: null, parent: null, ...over }) as RunFacts;
  const facts = new Map(
    Arr.map(
      [
        fact("a", { task: "t" }),
        fact("b", { task: "t", parent: "p" }),
        fact("p", { task: "u" }),
        fact("c", { parent: "a" }),
        fact("asker", {
          requestedBy: { run: "b", agent: "a", machine: { installation: "i", name: "here" } },
        }),
        fact("other", { task: "v" }),
        fact("plan"),
      ],
      (one) => [one.id, one] as const,
    ),
  );
  const order = ["a", "b", "p", "c", "asker", "other", "plan"];
  const ids = (runs: ReadonlyArray<RunFacts> | null) =>
    runs === null ? null : Arr.map(runs, (one) => one.id);
  expect(ids(relatedOf(facts, order, "a", ["plan"]))).toEqual([
    "a",
    "b",
    "p",
    "c",
    "asker",
    "plan",
  ]);
  expect(relatedOf(facts, order, "a", ["unknown"])).toBeNull();
  expect(relatedOf(facts, order, "missing", [])).toBeNull();
  // A Run asked of the engine before any listing named it is not yet in the listing's order.
  expect(relatedOf(facts, ["b", "p"], "a", [])).toBeNull();
});
