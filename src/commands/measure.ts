import { Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import { err } from "../operations";
import { measureRun, refusal } from "../lifecycle";
import { FrontDoor, HostRefused } from "../board-model";
import { MeasurementJson, summaryOf, type Measurement } from "../measurement-model";
import { answering, cliDoor } from "./shared";

/**
 * A Measurement of a Run's checkout against a base, which the host takes on the Run's own
 * Machine, or the one it already recorded for the same trees and plan. Not a mutation: the
 * host answers a repeat with the record, whatever request id it came with.
 */
export const measure = Command.make(
  "measure",
  {
    runId: Flag.String("run").pipe(
      Flag.withDescription("The Run measured; by default the Run whose agent this pane is"),
      Flag.optional,
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription(
        "The candidate tree, inside that Run's own checkout; by default its checkout",
      ),
      Flag.optional,
    ),
    base: Flag.String("base").pipe(
      Flag.withDescription(
        "The commit the base tree is made at, with the plan's harness commits applied",
      ),
    ),
    plan: Flag.String("plan").pipe(
      Flag.withDescription("A file holding the Run's benchmark plan as JSON"),
    ),
    pass: Flag.String("pass").pipe(
      Flag.withDescription("Which Measurement this is: `calibration`, `cycle N` or `final`"),
    ),
    reason: Flag.String("reason").pipe(
      Flag.withDescription(
        "Why the plan changed; needed where the Run was measured under another plan",
      ),
      Flag.optional,
    ),
  },
  ({ runId, cwd, base, plan, pass, reason }) =>
    answering((env) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const text = yield* fs.readFileString(plan).pipe(Effect.option);
          if (Option.isNone(text)) return err("invalid_input", `No plan to read at "${plan}".`);
          const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(
            text.value,
          );
          if (Option.isNone(decoded))
            return err("invalid_input", `The plan at "${plan}" is not JSON.`);
          const door = yield* cliDoor(env);
          const run = Option.getOrElse(runId, () =>
            Schema.is(FrontDoor)(door) ? null : door.from.run,
          );
          if (run === null)
            return err("invalid_input", "measure needs --run outside a Run's agent pane.");
          const request = {
            runId: run,
            base,
            plan: decoded.value,
            pass,
            ...Option.match(reason, { onNone: () => ({}), onSome: (why) => ({ reason: why }) }),
          };
          const where = Option.getOrUndefined(cwd);
          const opened = yield* measureRun(
            env,
            where === undefined ? request : { ...request, cwd: where },
            door,
          );
          if (!opened.ok) return opened;
          const stdio = yield* Stdio.Stdio;
          type Answered = { measurement: Measurement; ran: boolean };
          const answered = yield* Stream.runFoldEffect(
            opened.events,
            (): Answered | null => null,
            (last, event) =>
              event._tag === "Said"
                ? Stream.make(`${event.text}\n`).pipe(
                    Stream.run(stdio.stderr({ endOnDone: false })),
                    Effect.ignore,
                    Effect.as(last),
                  )
                : Effect.succeed({ measurement: event.measurement, ran: event.ran }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.succeed(
                Schema.is(HostRefused)(cause)
                  ? refusal(cause)
                  : err("operation_failed", String(cause)),
              ),
            ),
          );
          if (answered === null)
            return err("operation_failed", "The Measurement ended without a record.");
          if ("ok" in answered) return answered;
          const { measurement, ran } = answered;
          return {
            ok: true as const,
            data: { measurement: Schema.encodeSync(MeasurementJson)(measurement), ran },
            human: `${measurement.pass}: ${summaryOf(measurement)}${ran ? "" : `, not measured again: Measurement ${measurement.id} of these trees under this plan`}`,
          };
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Measure a Run's checkout against a base tree, alternately, and judge each metric",
  ),
  Command.withExamples([
    {
      command: "collie measure --base origin/master --plan bench/plan.json --pass calibration",
      description: "From a Run's agent pane: the base tree against itself, to learn the noise",
    },
    {
      command:
        "collie --json measure --run tune-up-api-20261028-101112 --base 4f2c1a9 --plan plan.json --pass 'cycle 2'",
      description: "Anywhere else: name the Run",
    },
  ]),
);
