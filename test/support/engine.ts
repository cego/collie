import { Effect, FileSystem, Path } from "effect";
import type { Rig } from "./recorder";

export function installBaseline(rig: Rig) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    yield* fs.copy(path.join(root, "workflows"), path.join(rig.baselineDir, "workflows"));
    yield* fs.copy(path.join(root, "personas"), path.join(rig.baselineDir, "personas"));
  });
}
