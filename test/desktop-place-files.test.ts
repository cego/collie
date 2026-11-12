// A file given to a pane is placed on the pane's Machine (ADR-0065):
// Desktop's copy is uploaded through the host's `upload` in parts, once per content, and its
// path there is answered; a file that cannot be placed names itself and places nothing more.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { HostRefused } from "../src/board-model";
import { stagePath } from "../desktop/src/bun/attachments";
import type { StagedOrRefused } from "../desktop/src/shared/attachments";
import { placeStaged } from "../desktop/src/bun/carried";

interface Uploaded {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly offset: number;
  readonly content: string;
}

const inDir = <A, E>(body: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* body(yield* fs.makeTempDirectoryScoped({ prefix: "place-files-" }));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

/** A Machine whose host keeps what it is sent, under its own uploads directory. */
const machine = (files = true, refuse?: string) => {
  const sent: Uploaded[] = [];
  return {
    sent,
    machine: {
      name: "vm-mk",
      files,
      door: {
        upload: (part: Uploaded) =>
          refuse === undefined
            ? Effect.sync(() => {
                sent.push(part);
                return { path: `/home/mk/.local/state/collie/uploads/${part.sha256}/${part.name}` };
              })
            : Effect.fail(new HostRefused({ reason: refuse })),
      },
    },
  };
};

const idOf = (staged: StagedOrRefused) => ("id" in staged ? staged.id : "");

test("a staged file is uploaded to the pane's Machine once and answered with its path there", () =>
  inDir((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dir}/shot one.png`, "PNG!");
      yield* fs.writeFileString(`${dir}/notes.txt`, "hello");
      const shot = idOf(yield* stagePath(`${dir}/own`, `${dir}/shot one.png`));
      const notes = idOf(yield* stagePath(`${dir}/own`, `${dir}/notes.txt`));
      const held = new Map();
      const vm = machine();

      const paths = yield* placeStaged(held, vm.machine, `${dir}/own`, [shot, notes]);
      const sha = (id: string) => pipe(id, Str.slice(0, 64));
      expect(paths).toEqual([
        `/home/mk/.local/state/collie/uploads/${sha(shot)}/shot one.png`,
        `/home/mk/.local/state/collie/uploads/${sha(notes)}/notes.txt`,
      ]);
      expect(Arr.map(vm.sent, ({ name, offset, size }) => ({ name, offset, size }))).toEqual([
        { name: "shot one.png", offset: 0, size: 4 },
        { name: "notes.txt", offset: 0, size: 5 },
      ]);

      // Placed again the same day, nothing is sent again.
      expect(yield* placeStaged(held, vm.machine, `${dir}/own`, [shot])).toEqual(paths.slice(0, 1));
      expect(vm.sent).toHaveLength(2);
    }),
  ));

test("a file Desktop holds no copy of, or a host that refuses, places nothing and says which file", () =>
  inDir((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dir}/shot.png`, "PNG!");
      const shot = idOf(yield* stagePath(`${dir}/own`, `${dir}/shot.png`));
      const gone = `${pipe("0", Str.repeat(64))}/gone.png`;

      const vm = machine();
      const missing = yield* placeStaged(new Map(), vm.machine, `${dir}/own`, [gone, shot]).pipe(
        Effect.flip,
      );
      expect(missing.reason).toBe("gone.png is no longer held by Desktop; paste it again");
      expect(vm.sent).toEqual([]);

      const full = machine(true, "the disk is full");
      const refused = yield* placeStaged(new Map(), full.machine, `${dir}/own`, [shot]).pipe(
        Effect.flip,
      );
      expect(refused.reason).toBe("shot.png could not be placed on vm-mk: the disk is full");

      const old = machine(false);
      const older = yield* placeStaged(new Map(), old.machine, `${dir}/own`, [shot]).pipe(
        Effect.flip,
      );
      expect(older.reason).toBe(
        "vm-mk's Collie does not take files; upgrade Collie on vm-mk. Nothing was pasted.",
      );
      expect(old.sent).toEqual([]);
    }),
  ));
