import { expect, test } from "bun:test";
import { ByteSize, Effect, FileSystem } from "effect";
import * as PlatformError from "effect/PlatformError";
import { Artefacts } from "../src/artefacts";
import { ATTACHMENT_BYTES } from "../src/attachments";
import { PART_BYTES } from "../src/board-model";
import { madeRun } from "./support/records";
import { runEffect } from "./support/effect";

test("unstable copies fail in bounded attempts and preserve the prior snapshot with its failure", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const run = yield* madeRun(dir);
      const catalogue = yield* Artefacts;
      const file = `${dir}/changing.txt`;
      yield* fs.writeFileString(file, "good");
      const first = yield* catalogue.register(run, "inst", { path: file }, "first", {
        origin: "cli",
        requestId: "first",
      });
      let reads = 0;
      const racing = {
        ...fs,
        readFile: (path: string) =>
          fs
            .readFile(path)
            .pipe(
              Effect.tap(() =>
                path === file
                  ? fs.writeFileString(file, ++reads % 2 ? "race" : "edit")
                  : Effect.void,
              ),
            ),
      };
      const refused = yield* catalogue
        .register(run, "inst", { path: file }, "racing", { origin: "cli", requestId: "racing" })
        .pipe(Effect.provideService(FileSystem.FileSystem, racing), Effect.flip);
      expect(refused._tag).toBe("HostRefused");
      expect(reads).toBe(6);
      const held = (yield* catalogue.list(run.id))[0]!;
      expect(held).toMatchObject({
        revision: 1,
        digest: first.item.digest,
        sourceAvailability: "refresh-failed",
      });
      expect(held.reason).toContain("changed");
      expect(
        Buffer.from((yield* catalogue.read(run, first.item.id, 1, 0)).content, "base64").toString(),
      ).toBe("good");
      yield* fs.writeFileString(file, "safe");
      const final = yield* catalogue.register(run, "inst", { path: file }, "racing", {
        origin: "cli",
        requestId: "racing",
      });
      expect(final.item.revision).toBe(2);
    }),
  ));

test("invalid sources cannot publish blobs and later access or size failures keep retained bytes", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const run = yield* madeRun(dir);
      const catalogue = yield* Artefacts;
      const file = `${dir}/allowed.txt`;
      yield* fs.writeFileString(file, "allowed");
      const one = yield* catalogue.register(run, "inst", { path: file }, "one", {
        origin: "cli",
        requestId: "one",
      });
      yield* fs.makeDirectory(`${dir}/links`);
      yield* fs.symlink(file, `${dir}/links/escape.txt`);
      for (const path of [dir, "/dev/null", `${dir}/../escape.txt`, `${dir}/links/escape.txt`]) {
        const result = yield* catalogue
          .register(run, "inst", { path }, path, { origin: "cli", requestId: path })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      const overCap = {
        ...fs,
        stat: (path: string) =>
          fs
            .stat(path)
            .pipe(
              Effect.map((info) =>
                path === file ? { ...info, size: ByteSize.bytes(ATTACHMENT_BYTES + 1) } : info,
              ),
            ),
      };
      const failed = yield* catalogue
        .register(run, "inst", { path: file }, "huge", { origin: "cli", requestId: "huge" })
        .pipe(Effect.provideService(FileSystem.FileSystem, overCap), Effect.result);
      expect(failed._tag).toBe("Failure");
      const denied = {
        ...fs,
        access: (path: string, options?: Parameters<typeof fs.access>[1]) =>
          path === file
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "access",
                }),
              )
            : fs.access(path, options),
      };
      yield* catalogue.reconcile(run).pipe(Effect.provideService(FileSystem.FileSystem, denied));
      expect((yield* catalogue.list(run.id))[0]?.sourceAvailability).toBe("denied");
      expect(
        Buffer.from((yield* catalogue.read(run, one.item.id, 1, 0)).content, "base64").toString(),
      ).toBe("allowed");
      expect(yield* catalogue.list(run.id)).toHaveLength(1);
    }),
  ));

test("a read keeps its revision across parts while a newer revision is retained", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const run = yield* madeRun(dir);
      const catalogue = yield* Artefacts;
      const file = `${dir}/large.bin`;
      const first = Buffer.concat([Buffer.alloc(PART_BYTES, "a"), Buffer.from("first tail")]);
      const second = Buffer.concat([Buffer.alloc(PART_BYTES, "b"), Buffer.from("second tail")]);
      yield* fs.writeFile(file, first);
      const { item } = yield* catalogue.register(run, "inst", { path: file }, "one", {
        origin: "cli",
        requestId: "one",
      });
      const head = yield* catalogue.read(run, item.id, 1, 0);
      yield* fs.writeFile(file, second);
      yield* catalogue.reconcile(run);
      expect((yield* catalogue.list(run.id))[0]?.revision).toBe(2);
      const tail = yield* catalogue.read(run, item.id, 1, PART_BYTES);
      expect(head.size).toBe(first.length);
      expect(
        Buffer.concat([Buffer.from(head.content, "base64"), Buffer.from(tail.content, "base64")]),
      ).toEqual(first);
      expect(
        Buffer.from(
          (yield* catalogue.read(run, item.id, 2, PART_BYTES)).content,
          "base64",
        ).toString(),
      ).toBe("second tail");
    }),
  ));
