import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { upgrade as upgradeInstallation } from "../operations";
import { attempt } from "../envelope";
import { context, root } from "./shared";

const toFlag = Flag.String("to").pipe(
  Flag.withDescription("Move a release to exactly this version, older or newer"),
  Flag.optional,
);

export const upgrade = Command.make("upgrade", { to: toFlag }, ({ to }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
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
      description:
        "Move a release to the newest release, or pull a development checkout, then bring every prerequisite up to date",
    },
    {
      command: "collie upgrade --to 0.27.0",
      description: "Move a release to exactly 0.27.0; a development checkout is never moved",
    },
  ]),
);
