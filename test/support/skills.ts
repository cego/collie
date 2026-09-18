// The skills a baseline Workflow asks for, seeded for a test that resolves one.
//
// They are installed on a developer's machine and on nobody else's: a test that leans on
// the real `$HOME` is green for whoever wrote it and "implement is not runnable" on a
// clean checkout, which is CI. So the test brings its own.

import { Effect, FileSystem, Path } from "effect";
import { loadDefaults } from "../../src/config";
import { layers, loadDefinitions, requiredSkills, resolveWorkflow } from "../../src/definitions";
import type { PluginEnv } from "../../src/env";

/**
 * The same environment with a home of its own, holding a stub of every skill those
 * Workflows require. The home is the state directory, so the test's own cleanup takes it.
 */
export const withSkills = Effect.fn("test.withSkills")(function* (
  env: PluginEnv,
  ...workflows: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const seeded: PluginEnv = { ...env, home: env.stateDir };
  const defs = yield* loadDefinitions(yield* layers(seeded));
  const defaults = yield* loadDefaults(seeded.configDir);
  const store = path.join(seeded.home, ".agents", "skills");
  for (const workflow of workflows) {
    for (const name of requiredSkills(resolveWorkflow(workflow, defs, defaults), defs).keys()) {
      yield* fs.makeDirectory(path.join(store, name), { recursive: true });
      yield* fs.writeFileString(path.join(store, name, "SKILL.md"), `# ${name}\n`);
    }
  }
  return seeded;
});
