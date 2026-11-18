// `collie_submit`: an agent's Output handed to the host rather than written by the agent.
// The host decodes it with the step's own decoder and, once it is usable, writes the file
// the step is already collecting, so collection, reminders and repair are the file's.

import { Effect, FileSystem, flow, Result, Schema } from "effect";
import { isString } from "./schema";

interface Awaited {
  readonly output: string;
  /** Every reason this text is not the step's Output, or null where it is. */
  readonly problem: (text: string) => string | null;
  readonly collected?: string;
}

// ponytail: one entry per agent the host has run, never removed; prune when a Run ends if hosts live for months.
const awaiting = new Map<string, Awaited>();
const keyOf = (runId: string, agent: string) => `${runId}\n${agent}`;

/** The step `agent` is collecting now writes `output`, and is decoded this way. */
export const awaitOutput = (
  runId: string,
  agent: string,
  output: string,
  problem: (text: string) => string | null,
) => Effect.sync(() => void awaiting.set(keyOf(runId, agent), { output, problem }));

/** The step has its Output: a submit of the same text is answered as accepted, any other refused. */
export const outputCollected = (runId: string, agent: string, text: string) =>
  Effect.sync(() => {
    const entry = awaiting.get(keyOf(runId, agent));
    if (entry !== undefined) awaiting.set(keyOf(runId, agent), { ...entry, collected: text });
  });

const asText = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

/** What `collie_submit` answers: "accepted", or every reason the Output cannot be used. */
export const submitOutput = Effect.fn("OutputSubmit.submit")(function* (
  runId: string,
  agent: string,
  output: Schema.Json,
) {
  const entry = awaiting.get(keyOf(runId, agent));
  if (entry === undefined)
    return `No step of ${runId} is waiting for ${agent}'s Output. Nothing was written.`;
  // A string is the file's text: a plain-text Output, or JSON already encoded.
  const text = isString(output) ? output : asText(output);
  if (entry.collected !== undefined)
    return entry.collected === text
      ? "accepted"
      : `${entry.output} was already collected, and this Output differs from it. Nothing was written.`;
  const problem = entry.problem(text);
  if (problem !== null)
    return `Your Output is not usable: ${problem}\n\nNothing was written. Correct it and submit it again.`;
  const fs = yield* FileSystem.FileSystem;
  // Renamed into place, so the collection never reads half of it.
  yield* fs.writeFileString(`${entry.output}.submitted`, text);
  yield* fs.rename(`${entry.output}.submitted`, entry.output);
  return "accepted";
});
