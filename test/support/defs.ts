import { Effect, FileSystem, Path } from "effect";
import type { Layer } from "../../src/definitions";

export function writeDef(dir: string, kind: "workflows" | "personas", name: string, text: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(dir, kind, `${name}.md`);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
    return file;
  });
}

export function layerSet(baseline: string, user: string, project: string): Layer[] {
  return [
    { name: "baseline", dir: baseline },
    { name: "user", dir: user },
    { name: "project", dir: project },
  ];
}
