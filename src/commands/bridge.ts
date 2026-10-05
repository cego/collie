// `collie bridge`: a front door's byte stream to this Machine's host, as one command.
//
// Started over SSH by Desktop, or locally without it. Nobody types it: a front door reads
// past the ready marker and speaks the host's protocol from there.

import { Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { bridge as pipeToHost } from "../bridge";

export const bridge = Command.make(
  "bridge",
  {
    as: Flag.Literals("as", ["board", "desktop", "chat"]).pipe(
      Flag.withDescription(
        "The front door this channel is, which its every operation is recorded as",
      ),
    ),
    client: Flag.String("client").pipe(
      Flag.withDescription("The computer the front door runs on, recorded with what it does"),
      Flag.optional,
    ),
  },
  (flags) => pipeToHost(flags.as, Option.getOrNull(flags.client)),
).pipe(
  Command.withDescription(
    "Pipe this Machine's host to stdio for a front door, starting the host if none runs",
  ),
);
