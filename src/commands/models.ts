// `collie models`: which models and efforts each harness on a Machine offers, as its host
// last read them (the Harness catalogue).

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { modelsLines } from "../catalogue-model";
import { catalogueReadings } from "../lifecycle";
import { err } from "../operations";
import { HARNESS_NAMES } from "../settings";
import { answering, cliDoor } from "./shared";

const isHarness = (name: string) => HARNESS_NAMES.some((harness) => harness === name);

export const models = Command.make(
  "models",
  {
    harness: Flag.String("harness").pipe(
      Flag.withDescription(`Only this harness: ${HARNESS_NAMES.join(", ")}`),
      Flag.optional,
    ),
  },
  ({ harness }) =>
    answering((env) =>
      Effect.gen(function* () {
        const only = Option.getOrNull(harness);
        if (only !== null && !isHarness(only))
          return err(
            "invalid_input",
            `No harness "${only}"; it is one of ${HARNESS_NAMES.join(", ")}.`,
          );
        const read = yield* catalogueReadings(env, yield* cliDoor(env));
        if (!read.ok) return read;
        return {
          ok: true as const,
          data: {
            machine: read.machine,
            catalogues: read.value.filter((one) => only === null || one.harness === only),
          },
          human: modelsLines(read.value, only ?? undefined),
        };
      }),
    ),
).pipe(Command.withDescription("Which models and efforts each installed harness offers"));
