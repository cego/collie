// A Run asked two Choices in turn whose options are solutions, the recommended one authored last.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as DurableDeferred from "effect/workflow/DurableDeferred";

const solutions = [
  {
    id: "jsonl",
    title: "Keep the JSONL file",
    detail: "No migration; queries stay a full scan.",
  },
  {
    id: "sqlite",
    title: "SQLite in the run directory",
    detail: "No server; the ledger stops being shared between Machines.",
  },
  {
    id: "postgres",
    title: "Postgres",
    detail: "Ops already runs it; migrations reuse the existing tooling.",
    recommended: true,
  },
];

const choose = (name: string) =>
  Effect.gen(function* () {
    const host = yield* Host;
    yield* host.asking((yield* Run).id, {
      name,
      prompt: "Which database should the ledger use?",
      options: solutions,
    });
    return yield* DurableDeferred.await(DurableDeferred.make(name, { success: Schema.String }));
  });

export default defineWorkflow({
  id: "solutions",
  title: "Ask two Choices between solutions",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  run: () =>
    Effect.all([choose("first"), choose("second")]).pipe(
      Effect.map((answers) => answers.join(",")),
    ),
});
