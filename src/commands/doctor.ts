import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { doctor as checkInstallation } from "../doctor";
import { attempt } from "../envelope";
import { context, root } from "./shared";

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        // No workspace, for the same reason `upgrade` needs none: these are checks on
        // this installation, and they have to work from a plain shell as much as from
        // inside herdr — a machine where nothing is set up yet is the point.
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        return yield* checkInstallation(resolved.env);
      }),
      global.json,
    );
  }),
).pipe(
  Command.withDescription("Check every prerequisite Collie needs, and print the fix for each"),
  Command.withExamples([
    {
      command: "collie doctor",
      description: "Report what is missing; exit non-zero if anything is",
    },
    { command: "collie doctor --json", description: "The same checks as data" },
  ]),
);
