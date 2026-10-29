// The user Layer's files as one host shares them: what it reads, and what it takes.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import { readAudit } from "../src/audit";
import { fileTime, nowIso } from "../src/time";
import { connect, frontDoor, socketOf } from "../src/host";
import { proves } from "./support/world";

const at = (hour: number) => `2099-10-14T${pipe_(String(hour), Str.padStart(2, "0"))}:00:00.000Z`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

test(
  "a host reads its shared definitions with their edit times, and takes only later edits",
  () =>
    proves(
      "collie-shared-definitions-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const user = world.config;
          const put = (path: string, text: string, hour: number) =>
            fs
              .writeFileString(`${user}/${path}`, text)
              .pipe(
                Effect.andThen(
                  fs.utimes(`${user}/${path}`, fileTime(at(hour)), fileTime(at(hour))),
                ),
              );
          const mtime = (path: string) =>
            fs
              .stat(`${user}/${path}`)
              .pipe(Effect.map((info) => Option.getOrThrow(info.mtime).toISOString()));
          yield* fs.makeDirectory(`${user}/personas`, { recursive: true });
          yield* fs.makeDirectory(`${user}/workflows/node_modules/effect`, { recursive: true });
          yield* fs.makeDirectory(`${user}/workflows/nested`, { recursive: true });
          yield* put("workflows/mine.workflow.ts", "the module\n", 1);
          yield* put("workflows/mine.md", "the prompt\n", 2);
          yield* put("workflows/helper.ts", "the helper\n", 3);
          yield* put("personas/me.md", "the persona\n", 4);
          for (const toolchain of ["package.json", "tsconfig.json", "collie.d.ts", "bun.lock"])
            yield* put(`workflows/${toolchain}`, "this Machine's own\n", 5);
          yield* put("workflows/node_modules/effect/package.json", "{}\n", 5);
          yield* put("workflows/nested/deeper.ts", "not shared\n", 5);
          // Neither an editor's leftovers nor a link, which would reach outside the Layer.
          yield* put("workflows/.mine.workflow.ts.swp", "vim's\n", 5);
          yield* put("workflows/mine.md~", "a backup\n", 5);
          yield* put("outside.txt", "not the Layer's\n", 5);
          yield* fs.symlink(`${user}/outside.txt`, `${user}/workflows/linked.ts`);

          yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({ frontDoor: "desktop", from: { client: "test-desktop" } });
          expect(yield* door.sharedDefinitions()).toEqual([
            { path: "personas/me.md", base64: b64("the persona\n"), at: at(4) },
            { path: "workflows/helper.ts", base64: b64("the helper\n"), at: at(3) },
            { path: "workflows/mine.md", base64: b64("the prompt\n"), at: at(2) },
            { path: "workflows/mine.workflow.ts", base64: b64("the module\n"), at: at(1) },
          ]);

          // A file seen and gone since is a removal, from when it was first missed.
          const before = yield* nowIso;
          yield* fs.remove(`${user}/workflows/helper.ts`);
          const removed = Option.getOrUndefined(
            Arr.findFirst(
              yield* door.sharedDefinitions(),
              (one) => one.path === "workflows/helper.ts",
            ),
          );
          expect(removed?.base64).toBeNull();
          expect(removed!.at >= before).toBe(true);
          // And it keeps that time, rather than being removed again at every read.
          expect(
            Option.getOrUndefined(
              Arr.findFirst(
                yield* door.sharedDefinitions(),
                (one) => one.path === "workflows/helper.ts",
              ),
            ),
          ).toEqual(removed);

          const held = yield* door.setSharedDefinitions({
            request: "share-1",
            definitions: [
              { path: "workflows/mine.md", base64: b64("a later prompt\n"), at: at(6) },
              { path: "workflows/mine.workflow.ts", base64: b64("an older module\n"), at: at(0) },
              { path: "personas/me.md", base64: null, at: at(7) },
              { path: "personas/new.md", base64: b64("a new persona\n"), at: at(8) },
              { path: "workflows/linked.ts", base64: b64("through the link\n"), at: at(8) },
            ],
          });
          expect(held).toEqual([
            { path: "personas/me.md", base64: null, at: at(7) },
            { path: "personas/new.md", base64: b64("a new persona\n"), at: at(8) },
            removed!,
            { path: "workflows/mine.md", base64: b64("a later prompt\n"), at: at(6) },
            { path: "workflows/mine.workflow.ts", base64: b64("the module\n"), at: at(1) },
          ]);
          expect(yield* mtime("workflows/mine.md")).toBe(at(6));
          expect(yield* mtime("personas/new.md")).toBe(at(8));
          expect(yield* fs.exists(`${user}/personas/me.md`)).toBe(false);
          expect(yield* fs.readFileString(`${user}/workflows/mine.workflow.ts`)).toBe(
            "the module\n",
          );
          // What a write replaced or removed is kept, by path and the time of its own edit.
          expect(yield* fs.readFileString(`${user}/replaced/${at(2)}/workflows/mine.md`)).toBe(
            "the prompt\n",
          );
          expect(yield* fs.readFileString(`${user}/replaced/${at(4)}/personas/me.md`)).toBe(
            "the persona\n",
          );
          expect(yield* fs.readFileString(`${user}/outside.txt`)).toBe("not the Layer's\n");
          expect(yield* fs.readFileString(`${user}/workflows/package.json`)).toBe(
            "this Machine's own\n",
          );

          // A path outside the two directories is refused, and nothing is written for it.
          const refused = yield* door
            .setSharedDefinitions({
              request: "share-2",
              definitions: [{ path: "workflows/../config.json", base64: b64("{}"), at: at(9) }],
            })
            .pipe(Effect.flip);
          expect(refused._tag).toBe("HostRefused");
          expect(yield* fs.exists(`${user}/config.json`)).toBe(false);

          // Both are recorded under the Actor that asked.
          const audited = yield* readAudit(`${world.state}/definitions`);
          expect(Arr.map(audited, (line) => line.operation)).toContain("definitions");
          expect(
            Option.getOrUndefined(Arr.findFirst(audited, (line) => line.request === "share-1"))
              ?.actor,
          ).toMatchObject({
            origin: "desktop",
            from: { client: "test-desktop" },
          });
        }).pipe(Effect.orDie),
      [],
    ),
  60_000,
);

test(
  "a host shares a file's bytes as they are, and neither reads nor writes through a link",
  () =>
    proves(
      "collie-shared-definitions-links-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const user = world.config;
          const outside = `${world.home}/outside`;
          const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
          yield* fs.makeDirectory(`${outside}/personas`, { recursive: true });
          yield* fs.makeDirectory(`${user}/workflows`, { recursive: true });
          yield* fs.writeFileString(`${outside}/personas/secret.md`, "not the Layer's\n");
          yield* fs.symlink(`${outside}/personas`, `${user}/personas`);
          yield* fs.symlink(`${outside}/dangling.ts`, `${user}/workflows/dangling.ts`);
          yield* fs.writeFile(`${user}/workflows/icon.png`, binary);
          yield* fs.utimes(`${user}/workflows/icon.png`, fileTime(at(1)), fileTime(at(1)));
          yield* fs.writeFileString(`${user}/workflows/kept.md`, "before\n");
          yield* fs.utimes(`${user}/workflows/kept.md`, fileTime(at(1)), fileTime(at(1)));
          yield* fs.makeDirectory(`${outside}/replaced`, { recursive: true });
          yield* fs.symlink(`${outside}/replaced`, `${user}/replaced`);

          yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({ frontDoor: "desktop", from: { client: "test-desktop" } });
          expect(yield* door.sharedDefinitions()).toEqual([
            {
              path: "workflows/icon.png",
              base64: Buffer.from(binary).toString("base64"),
              at: at(1),
            },
            { path: "workflows/kept.md", base64: b64("before\n"), at: at(1) },
          ]);

          // An edit at a time that is not one is refused whole, before anything is written.
          const refused = yield* door
            .setSharedDefinitions({
              request: "share-bad-time",
              definitions: [
                { path: "workflows/new.md", base64: b64("new\n"), at: at(2) },
                { path: "workflows/other.md", base64: b64("other\n"), at: "not-a-date" },
              ],
            })
            .pipe(Effect.flip);
          expect(refused._tag).toBe("HostRefused");
          expect(yield* fs.exists(`${user}/workflows/new.md`)).toBe(false);

          yield* door.setSharedDefinitions({
            request: "share-links",
            definitions: [
              { path: "workflows/dangling.ts", base64: b64("through the link\n"), at: at(3) },
              { path: "personas/secret.md", base64: b64("overwritten\n"), at: at(3) },
              { path: "workflows/kept.md", base64: b64("after\n"), at: at(3) },
              {
                path: "workflows/copy.png",
                base64: Buffer.from(binary).toString("base64"),
                at: at(3),
              },
            ],
          });
          expect(yield* fs.exists(`${outside}/dangling.ts`)).toBe(false);
          expect(yield* fs.readFileString(`${outside}/personas/secret.md`)).toBe(
            "not the Layer's\n",
          );
          // Nothing replaced is written while what it replaces could not be kept.
          expect(yield* fs.readDirectory(`${outside}/replaced`)).toEqual([]);
          expect(yield* fs.readFileString(`${user}/workflows/kept.md`)).toBe("before\n");
          expect(yield* fs.readFile(`${user}/workflows/copy.png`)).toEqual(binary);
        }).pipe(Effect.orDie),
      [],
    ),
  60_000,
);
