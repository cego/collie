import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { humanBytes } from "./bytes";
import type { PluginEnv } from "./env";
import { shell } from "./mr";
import type { Runner } from "./mr";

export const DF_ENV = "COLLIE_DF";

const LOW_SHARE = 0.1;
const LOW_BYTES = 5 * 1024 ** 3;

export interface Mount {
  readonly mount: string;
  readonly size: number;
  readonly free: number;
}

export const readDisk = Effect.fn("Disk.read")(function* (
  env: PluginEnv,
  dirs: ReadonlyArray<string>,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
) {
  const fs = yield* FileSystem.FileSystem;
  const present: Array<string> = [];
  for (const dir of dirs) {
    if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) {
      present.push(dir);
    }
  }
  if (present.length === 0) {
    return [];
  }
  const fake = env.raw[DF_ENV];
  const said = fake
    ? yield* fs.readFileString(fake).pipe(Effect.orElseSucceed(() => ""))
    : (yield* run("df", ["-Pk", ...present], "/")).stdout;
  const mounts = new Map<string, Mount>();
  for (const line of Str.split(said, "\n").slice(1)) {
    const [, blocks, , available, , ...mount] = Str.split(Str.trim(line), /\s+/);
    // WARNING: a line of df's complaints, not a filesystem.
    if (mount.length === 0 || !/^\d+$/.test(blocks ?? "") || !/^\d+$/.test(available ?? "")) {
      continue;
    }
    const name = Arr.join(mount, " ");
    mounts.set(name, {
      mount: name,
      size: Number(blocks) * 1024,
      free: Number(available) * 1024,
    });
  }
  return [...mounts.values()];
});

export const lowOn = (one: Mount) => one.free < LOW_BYTES || one.free < one.size * LOW_SHARE;

export const diskSaid = (one: Mount) =>
  `${one.mount} has ${humanBytes(one.free)} free (${Math.floor((one.free / one.size) * 100)}%)`;
