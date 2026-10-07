// A Machine's files, as its host hands them to the Flock chat over a front door: read in
// parts, found, written and edited, and never written inside the host's own state.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, Result, Schema, type Scope, Stream } from "effect";
import { HostRefused } from "../src/board-model";
import { readAudit } from "../src/audit";
import { connect, frontDoor } from "../src/host";
import { globFiles, grepFiles } from "../src/host-files";
import { pruneUploads, receive } from "../src/uploads";
import { proves } from "./support/world";

/** Why the host refused, where it did; anything else fails the test. */
const reasonOf = (error: { readonly _tag: string }) =>
  Schema.is(HostRefused)(error) ? error.reason : `not a refusal: ${String(error)}`;

test(
  "a chat channel reads, finds, writes and edits its Machine's files, and is refused the host's state",
  () =>
    proves(
      "collie-host-files-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* connect(world.state);
          const door = yield* frontDoor(world.state);
          yield* door.declare({
            frontDoor: "chat",
            conversation: "flock@mk-pc",
            said: "fix the config",
          });

          const first = yield* Stream.runHead(door.board());
          expect(
            first._tag === "Some" && first.value._tag === "Snapshot" && first.value.files,
          ).toBe(true);

          const notes = `${world.project}/notes.txt`;
          yield* fs.writeFileString(notes, "abcdef");
          const part = yield* door.readFile({ path: notes, offset: 2, length: 3 });
          expect(part).toEqual({
            path: notes,
            size: 6,
            mediaType: "text/plain",
            content: Buffer.from("cde").toString("base64"),
          });
          expect(reasonOf(yield* door.readFile({ path: "notes.txt" }).pipe(Effect.flip))).toContain(
            "absolute",
          );

          yield* fs.makeDirectory(`${world.project}/many`);
          for (let n = 0; n < 105; n++)
            yield* fs.writeFileString(`${world.project}/many/f${n}.ts`, `needle ${n}\n`);
          const found = yield* door.glob({ pattern: "**/*.ts", path: world.project });
          expect(found.paths).toHaveLength(100);
          expect(found.omitted).toBe(5);
          expect(found.paths[0]).toStartWith(`${world.project}/many/f`);

          const listed = yield* door.grep({ pattern: "needle", path: `${world.project}/many` });
          expect(listed.text.split("\n").filter((line) => line !== "")).toHaveLength(100);
          expect(listed.omitted).toBe(5);
          const lines = yield* door.grep({
            pattern: "needle 7$",
            path: `${world.project}/many`,
            outputMode: "content",
            lineNumbers: true,
          });
          expect(lines.text).toContain("f7.ts:1:needle 7");
          const one = yield* door.grep({
            pattern: "needle",
            path: `${world.project}/many/f7.ts`,
            outputMode: "content",
          });
          expect(one.text).toBe(`${world.project}/many/f7.ts:needle 7`);

          const config = `${world.project}/conf/app.ini`;
          yield* door.writeFile({ path: config, content: "a=1\na=1\n", request: "w-1" });
          expect(yield* fs.readFileString(config)).toBe("a=1\na=1\n");
          const twice = yield* door
            .editFile({ path: config, oldString: "a=1", newString: "a=2", request: "e-1" })
            .pipe(Effect.flip);
          expect(reasonOf(twice)).toContain("2 times");
          const edited = yield* door.editFile({
            path: config,
            oldString: "a=1",
            newString: "a=2",
            replaceAll: true,
            request: "e-2",
          });
          expect(edited).toEqual({ path: config, replaced: 2 });
          expect(yield* fs.readFileString(config)).toBe("a=2\na=2\n");
          yield* door.editFile({
            path: config,
            oldString: "a=2",
            newString: "b=$$VAR $& $' $`",
            replaceAll: true,
            request: "e-3",
          });
          expect(yield* fs.readFileString(config)).toBe("b=$$VAR $& $' $`\nb=$$VAR $& $' $`\n");

          yield* fs.symlink(world.state, `${world.project}/state`);
          yield* fs.symlink(`${world.state}/runs/planted.txt`, `${world.project}/dangling`);
          for (const path of [
            `${world.state}/runs/planted.txt`,
            `${world.project}/state/x.txt`,
            `${world.project}/dangling`,
          ]) {
            const refused = yield* door
              .writeFile({ path, content: "x", request: `w-${path}` })
              .pipe(Effect.flip);
            expect(reasonOf(refused)).toContain("state directory");
            expect(yield* fs.exists(`${world.state}/runs/planted.txt`)).toBe(false);
          }

          const trail = yield* readAudit(`${world.state}/files`);
          expect(
            trail.map(({ operation, actor }) => [operation, actor.origin, actor.said]),
          ).toEqual([
            ["write", "chat", "fix the config"],
            ["edit", "chat", "fix the config"],
            ["edit", "chat", "fix the config"],
          ]);
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test(
  "a file reaches a Machine once through its host's upload, and a start can name the path it answered",
  () =>
    proves(
      "collie-host-upload-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* connect(world.state);
          const door = yield* frontDoor(world.state);
          yield* door.declare({ frontDoor: "chat", conversation: "flock@mk-pc", said: "upload" });
          const bytes = new TextEncoder().encode("a screenshot, in two parts");
          const digest = sha256(bytes);
          const asked = { name: "shot.png", size: bytes.length, sha256: digest };

          const first = yield* door.upload({
            ...asked,
            offset: 0,
            content: base64(bytes.subarray(0, 10)),
          });
          expect(first.path).toBeNull();
          const last = yield* door.upload({
            ...asked,
            offset: 10,
            content: base64(bytes.subarray(10)),
          });
          expect(last.path).toBe(`${world.state}/uploads/${digest}/shot.png`);
          expect(yield* fs.readFile(last.path!)).toEqual(bytes);

          // Held already: answered at its first part, whatever that part holds.
          expect((yield* door.upload({ ...asked, offset: 0, content: "" })).path).toBe(last.path);
          // The same bytes under another name are found under that name.
          const again = yield* door.upload({ ...asked, name: "again.png", offset: 0, content: "" });
          expect(again.path).toBe(`${world.state}/uploads/${digest}/again.png`);

          const twice = new TextEncoder().encode("sent by two starts at once");
          const both = { name: "both.png", size: twice.length, sha256: sha256(twice) };
          const send = Effect.gen(function* () {
            yield* door.upload({ ...both, offset: 0, content: base64(twice.subarray(0, 10)) });
            return (yield* door.upload({
              ...both,
              offset: 10,
              content: base64(twice.subarray(10)),
            })).path;
          });
          const sent = yield* Effect.all([send, send], { concurrency: 2 });
          expect(sent).toEqual([
            `${world.state}/uploads/${both.sha256}/both.png`,
            `${world.state}/uploads/${both.sha256}/both.png`,
          ]);
          expect(yield* fs.readFile(sent[0]!)).toEqual(twice);

          const other = new TextEncoder().encode("not what the hash says");
          const lied = { name: "lie.png", size: other.length, sha256: sha256(bytes.subarray(1)) };
          const refused = yield* door
            .upload({ ...lied, offset: 0, content: base64(other) })
            .pipe(Effect.flip);
          expect(reasonOf(refused)).toContain("sha256");
          expect(yield* fs.exists(`${world.state}/uploads/${lied.sha256}`)).toBe(false);

          const { runId } = yield* door.start({
            project: world.project,
            id: "plain",
            request: "start-1",
            input: { note: "with the upload" },
            attachments: [last.path!],
          });
          expect(yield* fs.readFile(`${world.state}/runs/${runId}/attachments/shot.png`)).toEqual(
            bytes,
          );

          const trail = yield* readAudit(`${world.state}/uploads`);
          // As each arrived, and as what this host already held.
          expect(trail.map(({ operation, actor }) => [operation, actor.said])).toEqual([
            ["upload", "upload"],
            ["upload", "upload"],
            ["upload", "upload"],
            ["upload", "upload"],
          ]);
        }).pipe(Effect.orDie),
      ["plain.workflow.ts"],
    ),
  120_000,
);

const inTemp = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));

const local = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope | BunServices.BunServices>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

test("a glob stops listing, and a grep stops its search, at the bound, and a glob reaches dot paths it names", () =>
  local(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* inTemp("collie-search-bound-");
      for (const sub of ["a", "b", "c"]) {
        yield* fs.makeDirectory(`${dir}/${sub}`);
        for (let n = 0; n < 4; n++) yield* fs.writeFileString(`${dir}/${sub}/f${n}.ts`, "needle\n");
      }
      // A link back up is not followed, so the walk ends.
      yield* fs.symlink(dir, `${dir}/a/loop`);
      const globbed = yield* globFiles("**/*.ts", dir, 5);
      expect(globbed.paths).toHaveLength(5);
      expect((yield* globFiles("**/*.ts", dir)).paths).toHaveLength(12);
      yield* fs.makeDirectory(`${dir}/.github/workflows`, { recursive: true });
      yield* fs.writeFileString(`${dir}/.github/workflows/ci.yml`, "on: push\n");
      yield* fs.writeFileString(`${dir}/.env`, "KEY=1\n");
      // A dot-named path is found where the pattern names it, and only there.
      for (const [pattern, found] of [
        [".github/**/*.yml", [`${dir}/.github/workflows/ci.yml`]],
        [".env", [`${dir}/.env`]],
        ["**/.env", [`${dir}/.env`]],
        ["**/*.yml", []],
      ] as const)
        for (const root of [dir, `${dir}/`])
          expect((yield* globFiles(pattern, root)).paths).toEqual([...found]);
      expect((yield* globFiles("a/*.ts", `${dir}/`)).paths).toHaveLength(4);
      // A dot name inside braces is named too, and a linked root is followed.
      expect((yield* globFiles("{.env,.envrc}", dir)).paths).toEqual([`${dir}/.env`]);
      expect((yield* globFiles(".{github,gitlab}/**/*.yml", dir)).paths).toHaveLength(1);
      const link = `${yield* inTemp("collie-search-link-")}/root`;
      yield* fs.symlink(dir, link);
      expect((yield* globFiles("**/.env", link)).paths).toEqual([`${link}/.env`]);
      // A root that is no directory, or cannot be listed, is refused.
      expect(Result.isFailure(yield* Effect.result(globFiles("*", `${dir}/.env`)))).toBe(true);
      yield* Effect.acquireUseRelease(
        fs.makeDirectory(`${dir}/locked`, { mode: 0o000 }),
        () =>
          Effect.gen(function* () {
            // A directory below the root that cannot be read is passed by.
            expect((yield* globFiles("**/*.nomatch", dir)).paths).toEqual([]);
            if (process.getuid?.() !== 0)
              expect(Result.isFailure(yield* Effect.result(globFiles("*", `${dir}/locked`)))).toBe(
                true,
              );
          }),
        () => fs.chmod(`${dir}/locked`, 0o755).pipe(Effect.orDie),
      );
      const grepped = yield* grepFiles(
        { pattern: "needle", path: dir, outputMode: "content", headLimit: 2 },
        5,
      );
      expect(grepped.text.split("\n")).toHaveLength(2);
      expect(grepped.omitted).toBe(3);
    }),
  ));

test("a part at the wrong offset clears what arrived, and asking for a held file renews it", () =>
  local(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* inTemp("collie-upload-");
      const bytes = new TextEncoder().encode("twenty bytes of shot");
      const asked = { name: "shot.png", size: bytes.length, sha256: sha256(bytes) };
      const dir = `${state}/uploads/${asked.sha256}`;

      yield* receive(state, { ...asked, offset: 0, content: base64(bytes.subarray(0, 5)) });
      const skipped = yield* receive(state, {
        ...asked,
        offset: 10,
        content: base64(bytes.subarray(10)),
      }).pipe(Effect.flip);
      expect(reasonOf(skipped)).toContain("send it again from the start");
      expect(yield* fs.exists(`${dir}/.partial`)).toBe(false);

      yield* receive(state, { ...asked, offset: 0, content: base64(bytes) });
      const now = yield* Clock.currentTimeMillis;
      const weekAgo = now / 1000 - 8 * 24 * 60 * 60;
      yield* fs.utimes(dir, weekAgo, weekAgo);
      yield* receive(state, { ...asked, offset: 0, content: "" });
      yield* pruneUploads(state, now);
      expect(yield* fs.exists(`${dir}/shot.png`)).toBe(true);
    }),
  ));
