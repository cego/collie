// What an Installation reads at runtime, which the build embeds and the runner places as
// `release/`.

import { Effect, FileSystem, Path } from "effect";

export const RELEASE_TREE = [
  "package.json",
  "install.sh",
  "prepare.sh",
  "release-p256.pub",
  "workflows",
  "personas",
  "prompts",
  "skills/collie",
  "assets/brand/logos/collie-horizontal-light-512.png",
];

/** Every file the release carries from the checkout at `root`, relative to it. */
export const releaseFiles = Effect.fn("release.files")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: string[] = [];
  for (const entry of RELEASE_TREE) {
    const at = path.join(root, entry);
    if ((yield* fs.stat(at)).type === "File") {
      files.push(entry);
      continue;
    }
    for (const name of yield* fs.readDirectory(at, { recursive: true }))
      if ((yield* fs.stat(path.join(at, name))).type === "File") files.push(path.join(entry, name));
  }
  return files;
});
