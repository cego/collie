import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { bridge as pipeToHost } from "../bridge";
import { root } from "./shared";

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
  (flags) =>
    Effect.flatMap(root, (global) =>
      pipeToHost(flags.as, Option.getOrNull(flags.client), Option.getOrNull(global.machine)),
    ),
).pipe(
  Command.withDescription(
    "Pipe this Machine's host to stdio for a front door, starting the host if none runs",
  ),
);
