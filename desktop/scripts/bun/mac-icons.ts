// Electrobun's preBuild hook: the macOS app's icon set, made from the brand tile with sips.

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Config, Console, Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const SOURCE = `${import.meta.dir}/../../../assets/brand/logos/collie-tile-512.png`;
// What electrobun.config.ts names as `mac.icons`.
const ICONSET = `${import.meta.dir}/../../mac.iconset`;
const SIZES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
] as const;

const program = Effect.gen(function* () {
  const os = yield* Config.String("ELECTROBUN_OS").pipe(Config.withDefault(""));
  if (os !== "macos") return;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* fs.makeDirectory(ICONSET, { recursive: true });
  for (const [name, size] of SIZES) {
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "sips",
        ["-z", `${size}`, `${size}`, SOURCE, "--out", `${ICONSET}/${name}`],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      ),
    );
    const [exitCode, stderr] = yield* Effect.all(
      [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* new Cause.UnknownError(exitCode, `sips could not make ${name}: ${stderr}`);
  }
});

BunRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.tapCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Console.error(Cause.pretty(cause)),
    ),
    Effect.provide(BunServices.layer),
  ),
  { disableErrorReporting: true },
);
