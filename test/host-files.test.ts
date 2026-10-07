// A Machine's files, as its host hands them to the Flock chat over a front door: read in
// parts, found, written and edited, and never written inside the host's own state.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { HostRefused } from "../src/board-model";
import { readAudit } from "../src/audit";
import { connect, frontDoor } from "../src/host";
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

          for (const path of [`${world.state}/runs/planted.txt`, `${world.project}/state/x.txt`]) {
            if (path.includes("/project/"))
              yield* fs.symlink(world.state, `${world.project}/state`);
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
          ]);
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);
