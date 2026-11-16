import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema } from "effect";
import * as Arr from "effect/Array";
import { frontDoor, socketOf } from "../src/host";
import { collie, proves } from "./support/world";

test(
  "registration retains bytes before returning and deduplicates origins and requests",
  () =>
    proves(
      "collie-register-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=files"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data);
          yield* collie(world, ["run", "wait", runId]);
          const door = yield* frontDoor(socketOf(world.state));
          const a = `${world.project}/first/note.txt`;
          const b = `${world.project}/second/note.txt`;
          yield* fs.makeDirectory(`${world.project}/first`, { recursive: true });
          yield* fs.makeDirectory(`${world.project}/second`, { recursive: true });
          yield* fs.writeFileString(a, "first bytes");
          yield* fs.writeFileString(b, "other bytes");
          const args = { runId, path: a, request: "register-first" };
          const first = yield* door.artefactRegister(args);
          expect(first.address).toMatchObject({ run: runId, id: first.item.id });
          expect(first.address.installation).toBeTruthy();
          expect(first.retained).toEqual({ revision: 1, digest: first.item.digest, size: 11 });
          expect(first.item.tracking).toBe("local");
          const second = yield* door.artefactRegister({
            ...args,
            path: b,
            request: "register-other",
          });
          expect(second.item.id).not.toBe(first.item.id);
          const concurrent = yield* Effect.all(
            [
              door.artefactRegister({ ...args, request: "concurrent-1" }),
              door.artefactRegister({ ...args, request: "concurrent-2" }),
              door.artefactRegister(args),
            ],
            { concurrency: "unbounded" },
          );
          expect(Arr.map(concurrent, (one) => one.item.id)).toEqual([
            first.item.id,
            first.item.id,
            first.item.id,
          ]);
          yield* fs.writeFileString(b, "first bytes");
          const stillSeparate = yield* door.artefactRegister({
            ...args,
            path: b,
            request: "equal-bytes",
          });
          expect(stillSeparate.item.id).toBe(second.item.id);
          expect((yield* door.artefacts({ runId })).items).toHaveLength(2);
          yield* fs.remove(a);
          expect(
            Buffer.from(
              (yield* door.artefactRead({ runId, id: first.item.id, revision: 1, offset: 0 }))
                .content,
              "base64",
            ).toString(),
          ).toBe("first bytes");
          expect(yield* door.artefactRegister(args)).toEqual(first);
          expect(
            yield* door.artefactRegister({ ...args, path: b }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "RequestConflict" });
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "refresh tracks byte changes and source failures without losing a retained revision",
  () =>
    proves(
      "collie-track-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const start = yield* collie(world, ["run", "start", "plain", "--input", "note=tracking"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(start.envelope.data);
          yield* collie(world, ["run", "wait", runId]);
          const door = yield* frontDoor(socketOf(world.state));
          const path = `${world.project}/tracked.txt`;
          yield* fs.writeFileString(path, "aaa");
          yield* fs.utimes(path, 1_700_000_000, 1_700_000_000);
          const { item } = yield* door.artefactRegister({ runId, path, request: "track" });
          for (const [bytes, revision] of [
            ["bbb", 2],
            ["aaa", 3],
            ["aaa", 3],
          ] as const) {
            yield* fs.writeFileString(path, bytes);
            yield* fs.utimes(path, 1_700_000_000, 1_700_000_000);
            const found = Option.getOrThrow(
              Arr.findFirst(
                (yield* door.artefacts({ runId, refresh: true })).items,
                (one) => one.id === item.id,
              ),
            );
            expect(found.revision).toBe(revision);
            expect(
              Buffer.from(
                (yield* door.artefactRead({ runId, id: item.id, revision, offset: 0 })).content,
                "base64",
              ).toString(),
            ).toBe(bytes);
          }
          yield* fs.remove(path);
          const missing = Option.getOrThrow(
            Arr.findFirst(
              (yield* door.artefacts({ runId, refresh: true })).items,
              (one) => one.id === item.id,
            ),
          );
          expect(missing).toMatchObject({
            revision: 3,
            sourceAvailability: "missing",
            retainedAvailability: "available",
          });
          expect(missing.reason).toBeTruthy();
          expect(
            Buffer.from(
              (yield* door.artefactRead({ runId, id: item.id, revision: 1, offset: 0 })).content,
              "base64",
            ).toString(),
          ).toBe("aaa");
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);
