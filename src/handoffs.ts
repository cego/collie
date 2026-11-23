import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Path } from "effect";
import type { EvidenceFile } from "./board-model";

export const handoffsDir = (runDir: string) => `${runDir}/handoffs`;

export const handoffsIn = Effect.fn("Handoffs.in")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = handoffsDir(runDir);
  const kept: Array<EvidenceFile> = [];
  for (const name of (yield* fs
    .readDirectory(dir, { recursive: true })
    .pipe(Effect.orElseSucceed(() => []))).sort((a, b) => pipe_(a, Str.localeCompare(b)))) {
    const info = yield* fs.stat(path.join(dir, name)).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "File")
      kept.push({ name, bytes: Number(info.value.size) });
  }
  return kept;
});
