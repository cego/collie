// Collie's processes find each other by `COLLIE_*` names alone: a front door names the
// state directory, and the host it starts is there. Herdr 1's names are not read.

import { expect, test } from "bun:test";
import { Config, Effect, FileSystem } from "effect";
import { socketOf } from "../src/host";
import { exec } from "./support/command";
import { runEffect, suiteEnv } from "./support/effect";
import { stopHost } from "./support/host";
import { collieCommand } from "./support/world";

const ROOT = new URL("../", import.meta.url).pathname;
const DEFAULT = ".local/state/herdr/plugins/cego.collie";

/** Where a front door given only `names` found its host: each directory that has one. */
const hostedAt = (names: (dir: string) => Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "collie-env-names-" });
    const named = `${home}/named-state`;
    const PATH = yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"));
    const listed = yield* exec([...(yield* collieCommand), "--json", "host", "restart"], {
      cwd: home,
      env: { PATH, HOME: home, ...(yield* suiteEnv), ...names(named) },
    });
    const where = [
      ["named", named],
      ["default", `${home}/${DEFAULT}`],
    ] as const;
    const hosted: string[] = [];
    for (const [name, dir] of where) {
      if (yield* fs.exists(socketOf(dir))) hosted.push(name);
      if (yield* fs.exists(dir)) yield* stopHost(dir);
    }
    return { ok: listed.exitCode === 0, hosted };
  }).pipe(Effect.scoped);

const expectHosted = (names: (dir: string) => Record<string, string>, at: string) =>
  runEffect(
    Effect.map(hostedAt(names), (found) => expect(found).toEqual({ ok: true, hosted: [at] })),
  );

test("a front door and its host find the state directory COLLIE_STATE_DIR names", () =>
  expectHosted((dir) => ({ COLLIE_ROOT: ROOT, COLLIE_STATE_DIR: dir }), "named"));

test("Herdr 1's names for the root and the state directory are not read", () =>
  expectHosted(
    (dir) => ({
      COLLIE_ROOT: ROOT,
      HERDR_PLUGIN_ROOT: "/nonexistent/herdr-root",
      HERDR_PLUGIN_STATE_DIR: dir,
    }),
    "default",
  ));

test("with no state directory named, the host is at the one Herdr 1's plugin used", () =>
  expectHosted(() => ({ COLLIE_ROOT: ROOT }), "default"));
