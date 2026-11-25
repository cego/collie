import { Effect, flow, Result, Schema } from "effect";
import { isString } from "./schema";
import { RunRecords } from "./run-records";
import { acceptedFor, collectedFor, markCollected, recordOutput } from "./step-output";
import type { RunRecordsApi } from "./run-records";

interface Awaited {
  readonly output: string;
  readonly problem: (text: string) => string | null;
  readonly dispatch: string | undefined;
}

const awaiting = new Map<string, Awaited>();
const keyOf = (runId: string, agent: string) => `${runId}\n${agent}`;

export const awaitOutput = (
  runId: string,
  agent: string,
  output: string,
  problem: (text: string) => string | null,
  dispatch: string | undefined = undefined,
) => Effect.sync(() => void awaiting.set(keyOf(runId, agent), { output, problem, dispatch }));

export const forgetStep = (runId: string, output: string) =>
  Effect.sync(() => {
    for (const [key, entry] of awaiting) {
      if (key.startsWith(`${runId}\n`) && entry.output === output) {
        awaiting.delete(key);
      }
    }
  });

/** What the collector does with the Output it takes: the step is done, and no later submit reaches it. */
export const takeOutput = (
  records: RunRecordsApi,
  step: { runId: string; output: string },
  text: string,
) =>
  Effect.gen(function* () {
    yield* forgetStep(step.runId, step.output);
    return yield* markCollected(records, step, text);
  });

export const forgetAwaited = Effect.sync(() => awaiting.clear());

const asText = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

export const submitOutput = Effect.fn("OutputSubmit.submit")(function* (
  runId: string,
  agent: string,
  output: Schema.Json,
) {
  const entry = awaiting.get(keyOf(runId, agent));
  if (entry === undefined) {
    return `No step of ${runId} is waiting for ${agent}'s Output yet. Nothing was written: submit it again.`;
  }
  const records = yield* RunRecords;
  const text = isString(output) ? output : asText(output);
  const problem = entry.problem(text);
  if (problem !== null) {
    return `Your Output is not usable: ${problem}\n\nNothing was written. Correct it and submit it again.`;
  }
  const step = { runId, output: entry.output, dispatch: entry.dispatch };
  const accepted = yield* acceptedFor(records, step);
  const taken = yield* collectedFor(records, step);
  const nextRound =
    taken !== null &&
    taken.dispatch !== undefined &&
    entry.dispatch !== undefined &&
    taken.dispatch !== entry.dispatch;
  if (accepted !== null && !nextRound) {
    return accepted.text === text
      ? "accepted"
      : "An Output was already accepted for this step, and this one differs from it. Nothing was written.";
  }
  yield* recordOutput(records, step, text);
  return "accepted";
});
