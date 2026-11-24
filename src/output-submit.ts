import { Effect, FileSystem, flow, Result, Schema } from "effect";
import { isString } from "./schema";

interface Awaited {
  readonly output: string;
  readonly problem: (text: string) => string | null;
  readonly collected?: string;
}

const awaiting = new Map<string, Awaited>();
const keyOf = (runId: string, agent: string) => `${runId}\n${agent}`;

export const awaitOutput = (
  runId: string,
  agent: string,
  output: string,
  problem: (text: string) => string | null,
) => Effect.sync(() => void awaiting.set(keyOf(runId, agent), { output, problem }));

/** Only a test can start a second Run on one process's agent names, and no host ever does. */
export const forgetAwaited = Effect.sync(() => awaiting.clear());

export const outputCollected = (runId: string, agent: string, text: string) =>
  Effect.sync(() => {
    const entry = awaiting.get(keyOf(runId, agent));
    if (entry !== undefined) {
      awaiting.set(keyOf(runId, agent), { ...entry, collected: text });
    }
  });

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
  const text = isString(output) ? output : asText(output);
  if (entry.collected !== undefined) {
    return entry.collected === text
      ? "accepted"
      : `${entry.output} was already collected, and this Output differs from it. Nothing was written.`;
  }
  const problem = entry.problem(text);
  if (problem !== null) {
    return `Your Output is not usable: ${problem}\n\nNothing was written. Correct it and submit it again.`;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${entry.output}.submitted`, text);
  yield* fs.rename(`${entry.output}.submitted`, entry.output);
  return "accepted";
});
