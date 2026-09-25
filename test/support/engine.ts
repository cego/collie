// The rig a test stands a Collie up in: a fake herdr, the shipped workflows in place,
// and the small pieces of state a behaviour under test needs to have existed first.
//
// Nothing here runs work. What executes a workflow is the host, and a test that wants a
// Run drives it through the same front door an operator does.

import { Effect, FileSystem, Path } from "effect";
import type { Rig } from "./recorder";

/** Copies the repo's real shipped workflows and personas into the rig's baseline layer. */
export function installBaseline(rig: Rig) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    yield* fs.copy(path.join(root, "workflows"), path.join(rig.baselineDir, "workflows"));
    yield* fs.copy(path.join(root, "personas"), path.join(rig.baselineDir, "personas"));
  });
}
