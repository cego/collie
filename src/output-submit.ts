import * as Str from "effect/String";
import { Effect, flow, Result, Schema } from "effect";
import { isString } from "./schema";
import { RunRecords } from "./run-records";
import { belongsTo, blank, submitFor } from "./step-output";
import type { Step } from "./step-output";

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
  dispatch?: string,
) => Effect.sync(() => void awaiting.set(keyOf(runId, agent), { output, problem, dispatch }));

export const forgetStep = (runId: string, output: string) =>
  Effect.sync(() => {
    for (const [key, entry] of awaiting) {
      if (Str.startsWith(`${runId}\n`)(key) && entry.output === output) {
        awaiting.delete(key);
      }
    }
  });

export const takeOutput = (step: Pick<Step, "runId" | "output">, text: string) =>
  Effect.as(forgetStep(step.runId, step.output), text);

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
  if (blank(text)) {
    return "Your Output is blank. Nothing was written: write your result, then submit it again.";
  }
  const problem = entry.problem(text);
  if (problem !== null) {
    return `Your Output is not usable: ${problem}\n\nNothing was written. Correct it and submit it again.`;
  }
  const step = { runId, output: entry.output, dispatch: entry.dispatch };
  const held = yield* submitFor(records, step, text);
  if (held === null || (held.text === text && belongsTo(held, entry.dispatch))) {
    return "accepted";
  }
  return held.text === text
    ? "An Output accepted for a later round of this step is already recorded, and this submission belongs to a round that is over. Nothing was written."
    : "An Output was already accepted for this step, and this one differs from it. Nothing was written.";
});
