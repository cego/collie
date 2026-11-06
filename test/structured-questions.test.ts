// A question whose options are solutions: every front door reads them recommended first,
// an answer names one by id or title, and a row an older host wrote reads as it always did.

import * as Arr from "effect/Array";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Clock, Effect, Result, Schema, flow } from "effect";
import { connect } from "../src/host";
import { RunView } from "../src/engine";
import { describeWaiting } from "../src/lifecycle";
import { factsOfView } from "../src/runs";
import { runWaits } from "../src/run-waits";
import { stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const decodeShown = flow(
  Schema.decodeUnknownResult(Schema.Struct({ run: RunView })),
  Result.getOrThrow,
);

/** The Run as `collie run show` hands it over. */
const shown = (world: World, runId: string) =>
  collie(world, ["run", "show", runId]).pipe(
    Effect.map(({ envelope }) => decodeShown(envelope.data).run),
  );

/** The board's Questions for the Run, built from what the CLI was shown. */
const boardQuestions = (world: World, view: RunView) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return (yield* runWaits(factsOfView(world.state, view), [], [], now)).questions;
  });

const opened = (world: World, runId: string, decision: string) =>
  until(
    () => shown(world, runId),
    (view) => Arr.some(view.waiting, (one) => one.name === decision && one.answer === null),
  );

const started = (world: World) =>
  Effect.gen(function* () {
    const host = yield* connect(world.state);
    const { runId } = yield* host.start({
      project: world.project,
      id: "solutions",
      request: "start-1",
      input: { goal: "pick a database" },
    });
    return runId;
  });

const answer = (world: World, runId: string, value: string, decision: string, request: string) =>
  collie(world, ["run", "answer", runId, value, "--decision", decision, "--request-id", request]);

test(
  "a structured decision lists its recommended solution first and is answered by id or title",
  () =>
    proves(
      "collie-solutions-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* started(world);
          const view = yield* opened(world, runId, "first");

          expect(describeWaiting(view)).toEqual([
            `waiting on "first": Which database should the ledger use? (Postgres (Recommended) | Keep the JSONL file | SQLite in the run directory)`,
            "  Postgres (Recommended): Ops already runs it; migrations reuse the existing tooling.",
            "  Keep the JSONL file: No migration; queries stay a full scan.",
            "  SQLite in the run directory: No server; the ledger stops being shared between Machines.",
          ]);
          const [question] = yield* boardQuestions(world, view);
          expect(question?.options).toEqual([
            {
              id: "postgres",
              title: "Postgres",
              detail: "Ops already runs it; migrations reuse the existing tooling.",
              subtitle: "Ops already runs it; migrations reuse the existing tooling.",
              recommended: true,
            },
            {
              id: "jsonl",
              title: "Keep the JSONL file",
              detail: "No migration; queries stay a full scan.",
              subtitle: "No migration; queries stay a full scan.",
            },
            {
              id: "sqlite",
              title: "SQLite in the run directory",
              detail: "No server; the ledger stops being shared between Machines.",
              subtitle: "No server; the ledger stops being shared between Machines.",
            },
          ]);

          const byId = yield* answer(world, runId, "postgres", "first", "a-1");
          expect(byId.envelope.data).toMatchObject({
            value: "postgres",
            fresh: true,
          });

          yield* opened(world, runId, "second");
          const byTitle = yield* answer(
            world,
            runId,
            "sqlite IN THE RUN directory",
            "second",
            "a-2",
          );
          expect(byTitle.envelope.data).toMatchObject({
            value: "sqlite",
            fresh: true,
          });

          const host = yield* connect(world.state);
          const again = yield* host.answer({
            runId,
            decision: "second",
            value: "sqlite in the run directory",
            request: "a-2",
          });
          expect(again).toMatchObject({ value: "sqlite", fresh: false });

          const other = yield* answer(world, runId, "jsonl", "first", "a-3");
          expect(other.envelope.error?.message).toContain('already answered "postgres" by');

          const done = yield* until(
            () => host.status({ runId }),
            (status) => status.status === "complete",
          );
          expect(done).toMatchObject({
            value: "first moved to Postgres, second moved to SQLite",
          });
          expect(Arr.map(yield* boardQuestions(world, view), (one) => one.shortfall)).toEqual([
            undefined,
          ]);
        }).pipe(Effect.orDie),
      ["solutions.workflow.ts"],
    ),
  120_000,
);

test(
  "a value that is neither an option's id nor its title is refused with the titles",
  () =>
    proves(
      "collie-solutions-refused-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* started(world);
          yield* opened(world, runId, "first");
          const refused = yield* answer(world, runId, "MySQL", "first", "a-1");
          expect(refused.envelope.error?.message).toContain(
            '"MySQL" is not one of Postgres, Keep the JSONL file, SQLite in the run directory',
          );
        }).pipe(Effect.orDie),
      ["solutions.workflow.ts"],
    ),
  120_000,
);

test(
  "rows an older host wrote, plain titles and none, list and answer as they did",
  () =>
    proves(
      "collie-solutions-legacy-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* started(world);
          yield* opened(world, runId, "first");
          yield* stopHost(world.state);
          const db = new Database(`${world.state}/host.db`);
          db.run(
            `UPDATE collie_decisions SET options = '["Go","Wait"]' WHERE run = ? AND decision = 'first'`,
            [runId],
          );
          db.run(
            `INSERT INTO collie_decisions (run, decision, prompt, options, asked, asker)
             VALUES (?, 'ask-op-1', 'Which region?', '[]', ?, 'op')`,
            [runId, "2999-01-01T00:00:00.000Z"],
          );
          db.close();

          const view = yield* shown(world, runId);
          expect(describeWaiting(view)).toEqual([
            `waiting on "first": Which database should the ledger use? (Go | Wait)`,
            `  Hold the Run: collie run hold ${runId} --reason "held at question first"`,
            `waiting on "ask-op-1": Which region?`,
          ]);
          const questions = yield* boardQuestions(world, view);
          expect(Arr.map(questions, (one) => one.options)).toEqual([
            [
              { id: "Go", title: "Go", subtitle: null },
              { id: "Wait", title: "Wait", subtitle: null },
            ],
            [],
          ]);
          expect(Arr.map(questions, (one) => one.shortfall)).toEqual([undefined, undefined]);

          const byTitle = yield* answer(world, runId, "go", "first", "a-1");
          expect(byTitle.envelope.data).toMatchObject({
            value: "Go",
            fresh: true,
          });
          const words = yield* answer(world, runId, "eu-west, near the users", "ask-op-1", "a-2");
          expect(words.envelope.data).toMatchObject({
            value: "eu-west, near the users",
            fresh: true,
          });
        }).pipe(Effect.orDie),
      ["solutions.workflow.ts"],
    ),
  120_000,
);
