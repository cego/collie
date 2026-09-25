// `collie host`: run the local workflow host for one state directory.
//
// Nobody is expected to type this. A client starts it when it needs one and leaves it
// running, and it is here as a command because that is how one program starts another
// copy of itself. Typing it is still the way to watch a host in a terminal.

import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { serve } from "../host";

export const host = Command.make(
  "host",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription("The state directory this host owns: its SQLite, socket and lock"),
    ),
  },
  (flags) => serve(flags.dir).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Run the local workflow host for a state directory (started for you when a client needs one)",
  ),
);
