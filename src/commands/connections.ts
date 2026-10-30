import { Effect } from "effect";
import { Command } from "effect/cli";
import { connectionsLines } from "../connection-model";
import { connectionReadings } from "../lifecycle";
import { answering, cliDoor } from "./shared";

export const connections = Command.make("connections", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const read = yield* connectionReadings(env, yield* cliDoor(env));
      if (!read.ok) return read;
      return {
        ok: true as const,
        data: { machine: read.machine, connections: read.value },
        human: connectionsLines(read.value),
      };
    }),
  ),
).pipe(Command.withDescription("Which services this Machine is logged in to"));
