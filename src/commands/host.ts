// `collie host`: run the local workflow host for one state directory, or replace it.
//
// Nobody is expected to type the bare command. A client starts it when it needs one and
// leaves it running, and it is here as a command because that is how one program starts
// another copy of itself. Typing it is still the way to watch a host in a terminal.

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { serve } from "../host";
import { restartHostAt } from "../lifecycle";
import { rollbackAt } from "../records-import";
import { err } from "../operations";
import { printResult } from "../envelope";
import { answering, root } from "./shared";

const restart = Command.make(
  "restart",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription("The state directory whose host to replace; this install's by default"),
      Flag.optional,
    ),
  },
  (flags) => answering((env) => restartHostAt(Option.getOrElse(flags.dir, () => env.stateDir))),
).pipe(
  Command.withDescription(
    "Stop the host that owns the state directory and start this install's, waiting until it answers",
  ),
);

const rollback = Command.make(
  "rollback",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription(
        "The state directory whose records to write back; this install's by default",
      ),
      Flag.optional,
    ),
  },
  (flags) =>
    answering((env) => {
      const dir = Option.getOrElse(flags.dir, () => env.stateDir);
      return rollbackAt(dir).pipe(
        Effect.map((done) =>
          done === "owned"
            ? err("invalid_state", `A host owns ${dir}; stop it before rolling its records back.`)
            : done === "rolled-back" || done === "not-migrated"
              ? {
                  ok: true as const,
                  data: { dir, done },
                  human:
                    done === "rolled-back"
                      ? `Wrote ${dir}'s Run records back to their files for an older build.`
                      : `${dir}'s Run records were never moved into its database.`,
                }
              : err(
                  "invalid_state",
                  `${dir} has a later build's migration ${done.later}; roll that build back first.`,
                ),
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Write a stopped host's Run records back to the files an older build reads, for a downgrade",
  ),
);

export const host = Command.make(
  "host",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription("The state directory this host owns: its SQLite, socket and lock"),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.dir)) return yield* serve(flags.dir.value).pipe(Effect.scoped);
      const global = yield* root;
      yield* printResult(
        err("invalid_input", "collie host needs --dir, or `restart`."),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "Run the local workflow host for a state directory (started for you when a client needs one)",
  ),
  Command.withSubcommands([restart, rollback]),
);
