// Collie's toasts reach whichever Desktop is connected to the host, never herdr.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Stream } from "effect";
import { connect, type HostClient } from "../src/host";
import { isSettled } from "../src/lifecycle";
import { until } from "./support/host";
import { hosted } from "./support/hosted";
import type { World } from "./support/world";

const herdrCalls = Effect.gen(function* () {
  const log = yield* (yield* FileSystem.FileSystem)
    .readFileString(Bun.env.FAKE_HERDR_LOG ?? "")
    .pipe(Effect.orElseSucceed(() => ""));
  return Arr.filter(Str.split(log, "\n"), (line) => line !== "");
});

/** A Run that finishes once answered, so a Desktop is surely listening when it does. */
const answeredRun = (client: HostClient, world: World, request: string) =>
  Effect.gen(function* () {
    const { runId } = yield* client.start({
      project: world.project,
      id: "proof",
      request,
      input: { note: request },
    });
    yield* until(
      () => client.run({ runId }),
      (view) => (view?.waiting.length ?? 0) > 0,
    );
    yield* client.answer({ runId, decision: "decision", request: `${request}-a`, value: "ship" });
    return runId;
  });

test(
  "a finished Run's toast reaches a connected Desktop with its Run id, and herdr is never asked to show one",
  () =>
    hosted("collie-toasts-", ({ world }) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state);
        const desktop = yield* client.toasts().pipe(
          Stream.filter((toast) => toast.sound === "done"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const runId = yield* answeredRun(client, world, "toasted");
        const toast = yield* Fiber.join(desktop).pipe(Effect.timeout("20 seconds"));
        expect(toast._tag === "Some" && toast.value).toMatchObject({
          runId,
          sound: "done",
          title: expect.stringContaining("finished"),
        });
        expect(
          Arr.filter(yield* herdrCalls, (line) => pipe(line, Str.includes('"notification'))),
        ).toEqual([]);
      }).pipe(Effect.orDie),
    ),
  60_000,
);

test(
  "with no Desktop connected a toast is dropped, the Run still finishes, and a Desktop that connects later is not sent it",
  () =>
    hosted("collie-toasts-none-", ({ world }) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state);
        const { runId: unseen } = yield* client.start({
          project: world.project,
          id: "hello",
          request: "nobody-listening",
          input: { name: "nobody" },
        });
        const ended = yield* until(
          () => client.run({ runId: unseen }),
          (view) => view !== null && isSettled(view),
        );
        expect(ended?.status.status).toBe("complete");

        const desktop = yield* client.toasts().pipe(Stream.runHead, Effect.forkScoped);
        const later = yield* answeredRun(client, world, "later");
        const toast = yield* Fiber.join(desktop).pipe(Effect.timeout("20 seconds"));
        expect(toast._tag === "Some" && toast.value.runId).toBe(later);
      }).pipe(Effect.orDie),
    ),
  60_000,
);
