// The rig a test stands a Collie up in: a fake herdr, the shipped workflows in place,
// and the small pieces of state a behaviour under test needs to have existed first.
//
// Nothing here runs work. What executes a workflow is the host, and a test that wants a
// Run drives it through the same front door an operator does.

import { Effect, FileSystem, Path, Schema } from "effect";
import { Herdr } from "../../src/herdr";
import type { PluginEnv } from "../../src/env";
import { fakeHerdr } from "./fake-herdr-core";
import type { Rig } from "./recorder";
import { VerifySpecSchema } from "../../src/verify-spec";

const encodeSpecs = Schema.encodeSync(Schema.fromJsonString(Schema.Array(VerifySpecSchema)));

export class EffectFakeHerdr extends Herdr {
  constructor(
    env: PluginEnv,
    private readonly configEnv: Record<string, string | undefined>,
  ) {
    super(env);
  }

  protected override exec(args: string[]) {
    return fakeHerdr(args, this.configEnv);
  }
}

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

/**
 * What a project that has written down its verifications looks like: one approved command
 * that passes. The collector runs it itself, so the Run's proof is collected rather than
 * scripted — which is the whole point of the gate.
 */
export function approveVerification(
  rig: Rig,
  spec: { name: string; executable: string; argv?: string[]; cwd?: string } = {
    name: "tests",
    executable: "true",
  },
) {
  return approveVerifications(rig, [spec]);
}

/** The same, for a project that has written down more than one. */
export function approveVerifications(
  rig: Rig,
  specs: ReadonlyArray<{
    name: string;
    executable: string;
    argv?: string[];
    cwd?: string;
  }>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(rig.projectDir, ".collie", "verify.json");
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(
      file,
      encodeSpecs(specs.map((spec) => ({ argv: [], cwd: ".", ...spec }))),
    );
  });
}
