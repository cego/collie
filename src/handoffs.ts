// What a Run's agents leave for whoever comes next: notes under the Run's own directory, so
// they are listed on its record and removed only with it.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Path } from "effect";
import type { EvidenceFile } from "./board-model";

export const handoffsDir = (runDir: string) => `${runDir}/handoffs`;

/** Every file under the Run's handoffs, by its path inside it, in name order. */
export const handoffsIn = Effect.fn("Handoffs.in")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = handoffsDir(runDir);
  const kept: EvidenceFile[] = [];
  for (const name of (yield* fs
    .readDirectory(dir, { recursive: true })
    .pipe(Effect.orElseSucceed(() => []))).sort((a, b) => pipe_(a, Str.localeCompare(b)))) {
    const info = yield* fs.stat(path.join(dir, name)).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "File")
      kept.push({ name, bytes: Number(info.value.size) });
  }
  return kept;
});
