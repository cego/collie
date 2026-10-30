// Electrobun's postBuild and postWrap hook: `app.name` also names the update archives, so
// the launcher entry on Linux, and the app bundle's name on macOS, are renamed here instead.

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Config, Console, Effect, FileSystem, Option, Path, String as Str } from "effect";
import { withCollieBundleName, withCollieName } from "../../src/desktop-entry";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const configured = yield* Config.all({
    dir: Config.option(Config.String("ELECTROBUN_BUILD_DIR")),
    name: Config.option(Config.String("ELECTROBUN_APP_NAME")),
  });
  if (Option.isNone(configured.dir) || Option.isNone(configured.name)) {
    return yield* new Cause.IllegalArgumentError(
      "ELECTROBUN_BUILD_DIR and ELECTROBUN_APP_NAME must be set",
    );
  }
  const dir = configured.dir.value;
  const name = configured.name.value;
  const rename = Effect.fn("DesktopEntry.rename")(function* (
    path: string,
    as: (text: string, name: string) => string,
  ) {
    yield* fs.writeFileString(path, as(yield* fs.readFileString(path), name));
  });
  let renamed = 0;
  for (const bundle of yield* fs.readDirectoryEntries(dir)) {
    if (bundle.type !== "Directory") continue;
    if (Str.endsWith(".app")(bundle.name)) {
      yield* rename(paths.join(dir, bundle.name, "Contents", "Info.plist"), withCollieBundleName);
      renamed++;
      continue;
    }
    for (const file of yield* fs.readDirectory(paths.join(dir, bundle.name))) {
      if (!Str.endsWith(".desktop")(file)) continue;
      yield* rename(paths.join(dir, bundle.name, file), withCollieName);
      renamed++;
    }
  }
  if (renamed === 0)
    return yield* new Cause.NoSuchElementError(
      `no desktop entry or app bundle under ${dir} to name Collie`,
    );
});

BunRuntime.runMain(
  program.pipe(
    Effect.tapCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Console.error(Cause.pretty(cause)),
    ),
    Effect.provide(BunServices.layer),
  ),
  { disableErrorReporting: true },
);
