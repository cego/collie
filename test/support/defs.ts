import { Effect, FileSystem, Path } from "effect";

export function installFakeSkills(home: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const skill of [
      "collie",
      "code-review",
      "code-review-and-quality",
      "code-simplification",
      "tdd",
      "grill-with-docs",
      "to-spec",
      "to-tickets",
      "wayfinder",
      "improve-codebase-architecture",
      "resolving-merge-conflicts",
      "git-workflow-and-versioning",
      "retro",
    ]) {
      const dir = path.join(home, ".agents", "skills", skill);
      yield* fs.makeDirectory(dir, { recursive: true });
      // WARNING: Installed means the SKILL.md file exists: both the check and the agent's mention need the file, not just the directory.
      yield* fs.writeFileString(path.join(dir, "SKILL.md"), `# ${skill}\n`);
    }
  });
}
