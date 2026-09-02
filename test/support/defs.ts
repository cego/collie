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

/**
 * The skills every baseline definition names, as empty directories under `home`.
 * They are a prerequisite, not what any test is about: without them no workflow
 * validates and nothing gets as far as the behaviour under test.
 */
export function installFakeSkills(home: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const skill of [
      "code-review",
      "code-review-and-quality",
      "code-simplification",
      "implement",
      "tdd",
      "grill-with-docs",
      "to-spec",
      "to-tickets",
      "wayfinder",
      "improve-codebase-architecture",
    ]) {
      const dir = path.join(home, ".agents", "skills", skill);
      yield* fs.makeDirectory(dir, { recursive: true });
      // The file, not just the directory: that is what "installed" means to both the
      // validator and the mention an agent is handed.
      yield* fs.writeFileString(path.join(dir, "SKILL.md"), `# ${skill}\n`);
    }
  });
}

export function layerSet(baseline: string, user: string, project: string): Layer[] {
  return [
    { name: "baseline", dir: baseline },
    { name: "user", dir: user },
    { name: "project", dir: project },
  ];
}
