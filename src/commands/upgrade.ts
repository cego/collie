import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { upgrade as upgradeInstallation } from "../operations";
import { attempt } from "../envelope";
import { context, root } from "./shared";

export const upgrade = Command.make("upgrade", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        // No workspace: upgrading is about this installation, not about a Run, and it
        // has to work from a plain shell as much as from inside herdr.
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        return yield* upgradeInstallation(resolved.env);
      }),
      global.json,
    );
  }),
).pipe(
  Command.withDescription("Update this installation of Collie and the `collie` on your PATH"),
  Command.withExamples([
    { command: "collie upgrade", description: "Pull if this is a checkout, then reinstall" },
  ]),
);
