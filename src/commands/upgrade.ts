import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { upgrade as upgradeInstallation } from "../operations";
import { attempt } from "../envelope";
import { context, root } from "./shared";

const toFlag = Flag.String("to").pipe(
  Flag.withDescription("Move a released install to exactly this version"),
  Flag.optional,
);

export const upgrade = Command.make("upgrade", { to: toFlag }, ({ to }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        // No workspace: upgrading is about this installation, not about a Run, and it
        // has to work from a plain shell as much as from inside herdr.
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        return yield* upgradeInstallation(resolved.env, { to: Option.getOrUndefined(to) });
      }),
      global.json,
    );
  }),
).pipe(
  Command.withDescription("Update this installation of Collie and the `collie` on your PATH"),
  Command.withExamples([
    {
      command: "collie upgrade",
      description: "Pull if this is a checkout, then bring every prerequisite up to date",
    },
    {
      command: "collie upgrade --to 0.27.0",
      description: "Move a released install to 0.27.0; a development checkout is never moved",
    },
  ]),
);
