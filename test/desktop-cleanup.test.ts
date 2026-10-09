// Desktop keeps only what it uses: the running bundle's update tar, the running and newest
// runner copies, 30 days of usage, and no dead Desktop's ssh control directory (ADR-0045 D5).

import { expect, test } from "bun:test";
import { Clock, DateTime, Effect, FileSystem, Schema } from "effect";
import { CleanupReport } from "../src/board-model";
import { desktopSweeper } from "../src/cleanup";
import {
  dataHomeOf,
  desktopRootOf,
  pruneDesktop,
  sshControlsPrefix,
  sweepSshControls,
} from "../src/desktop";
import { runEffect } from "./support/effect";
import { collie, proves } from "./support/world";

const DAY_MS = 24 * 60 * 60_000;

/** Desktop's channel folder under `dir`, running `running` at 0.36.0, with three tars. */
const installed = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = desktopRootOf(dataHomeOf(dir, `${dir}/data`));
    yield* fs.makeDirectory(`${root}/app/Resources`, { recursive: true });
    yield* fs.writeFileString(
      `${root}/app/Resources/version.json`,
      '{"version":"0.36.0","hash":"running","channel":"stable"}',
    );
    yield* fs.makeDirectory(`${root}/self-extraction`, { recursive: true });
    for (const name of ["running.tar", "older.tar", "running.tar.previous"])
      yield* fs.writeFileString(`${root}/self-extraction/${name}`, "x".repeat(4096));
    return root;
  });

test("macOS cleanup reads the installed app and keeps its running runner and tar", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-macos-" });
      const root = desktopRootOf(dataHomeOf(home, undefined, "darwin"));
      const bundle = `${home}/Applications/collie-desktop.app/Contents/Resources/version.json`;
      yield* fs.makeDirectory(bundle.slice(0, bundle.lastIndexOf("/")), { recursive: true });
      yield* fs.writeFileString(bundle, '{"version":"0.36.0","hash":"running"}');
      yield* fs.makeDirectory(`${root}/self-extraction`, { recursive: true });
      for (const name of ["running.tar", "older.tar"])
        yield* fs.writeFileString(`${root}/self-extraction/${name}`, "x");
      for (const version of ["0.34.0", "0.36.0", "0.37.0"])
        yield* fs.makeDirectory(`${root}/runners/${version}`, { recursive: true });
      const found = yield* desktopSweeper(root, `${home}/state`, bundle).judge;
      expect(found.remove.map((item) => item.target).sort()).toEqual([
        `${root}/runners/0.34.0`,
        `${root}/self-extraction/older.tar`,
      ]);
    }).pipe(Effect.scoped),
  ));

test("Desktop's start removes every staged tar but its own bundle's", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-" });
      const root = yield* installed(dir);

      yield* pruneDesktop({ root, state: `${dir}/state`, hash: "running", version: "0.36.0" });
      expect((yield* fs.readDirectory(`${root}/self-extraction`)).sort()).toEqual(["running.tar"]);
    }),
  ));

test("an update staged and not yet applied keeps its tar", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-" });
      const root = yield* installed(dir);
      yield* fs.writeFileString(`${root}/self-extraction/newer.tar`, "x");
      yield* fs.writeFileString(
        `${root}/self-extraction/.electrobun-prepared-update.json`,
        `{"schema_version":1,"identifier":"dk.cego.collie.desktop","channel":"stable","version":"0.37.0","hash":"newer","platform":"linux","arch":"x64","retained_tar_path":"${root}/self-extraction/newer.tar","artifact_file":"stable-linux-x64-newer.tar.zst"}`,
      );

      yield* pruneDesktop({ root, state: `${dir}/state`, hash: "running", version: "0.36.0" });
      expect((yield* fs.readDirectory(`${root}/self-extraction`)).sort()).toEqual([
        ".electrobun-prepared-update.json",
        "newer.tar",
        "running.tar",
      ]);
    }),
  ));

test("Desktop keeps the running and the newest runner copy, and 30 days of usage", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-" });
      const root = yield* installed(dir);
      for (const version of ["0.34.0", "0.36.0", "0.37.0"])
        yield* fs.makeDirectory(`${root}/runners/${version}`, { recursive: true });
      const now = yield* Clock.currentTimeMillis;
      const at = (days: number) => DateTime.formatIso(DateTime.makeUnsafe(now - days * DAY_MS));
      yield* fs.makeDirectory(`${dir}/state`);
      const recent = `{"at":"${at(10)}","session":"s","turn":"desktop"}`;
      yield* fs.writeFileString(
        `${dir}/state/flock-usage.jsonl`,
        `{"at":"${at(40)}","session":"s","turn":"desktop"}\n${recent}\n`,
      );

      yield* pruneDesktop({ root, state: `${dir}/state`, hash: "running", version: "0.36.0" });
      expect((yield* fs.readDirectory(`${root}/runners`)).sort()).toEqual(["0.36.0", "0.37.0"]);
      expect(yield* fs.readFileString(`${dir}/state/flock-usage.jsonl`)).toBe(`${recent}\n`);
    }),
  ));

test("a dead Desktop's ssh control directory is removed, and a live one's kept", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "controls-" });
      const gone = Bun.spawn(["true"]);
      yield* Effect.promise(() => gone.exited);
      const dead = `${tmp}/${sshControlsPrefix(gone.pid)}abc`;
      const live = `${tmp}/${sshControlsPrefix(process.pid)}def`;
      for (const one of [dead, live]) yield* fs.makeDirectory(one);

      expect(yield* sweepSshControls(tmp, Bun.env)).toEqual([dead]);
      expect(yield* fs.exists(live)).toBe(true);
    }),
  ));

test("collie cleanup lists Desktop's removable files as its own kind", () =>
  proves(
    "collie-cleanup-desktop-",
    (world) =>
      Effect.gen(function* () {
        const root = yield* installed(world.home);
        const listed = yield* collie(world, ["cleanup"], { XDG_DATA_HOME: `${world.home}/data` });
        const report = Schema.decodeUnknownSync(CleanupReport)(listed.envelope.data);
        const desktop = report.remove.filter((item) => item.kind === "desktop");
        expect(desktop.map((item) => item.target).sort()).toEqual([
          `${root}/self-extraction/older.tar`,
          `${root}/self-extraction/running.tar.previous`,
        ]);
        expect(desktop[0]?.bytes).toBeGreaterThanOrEqual(4096);
      }),
    [],
  ));
