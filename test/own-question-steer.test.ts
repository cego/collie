// A human's message to an agent closes that agent's own open question, with no revision
// (ADR-draft-a-humans-message-supersedes-a-runs-open-question D4). The host is a real one
// over a fake herdr, running `reuses`: one agent given two operations in turn.

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { connect } from "../src/host";
import { readEnv } from "../src/env";
import { resetExecutors } from "../src/executors";
import { isSettled } from "../src/lifecycle";
import { carryOutAsked } from "../src/run-actions";
import { controlDir } from "../src/compaction";
import { recordClaudeEvent } from "../src/compactors";
import { Launched } from "../src/launches";
import { TaskView } from "../src/board-model";
import { SENT_STATES, deliveriesOf } from "../src/steering";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const decodeLaunched = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Launched)),
  Result.getOrThrow,
);
const Board = Schema.Struct({ tasks: Schema.Array(TaskView) });

const asked = encode({
  session_id: "s-1",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_1",
  tool_input: {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        options: [
          { label: "Postgres (Recommended)", description: "the one ops runs" },
          { label: "SQLite", description: "a file beside the app" },
          { label: "JSONL", description: "no migration" },
        ],
        multiSelect: false,
      },
    ],
  },
});

test(
  "a human's message closes the agent's own question: nothing asks it again, a later answer goes nowhere, and its next step is sent",
  () =>
    proves(
      "collie-own-question-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs
            .writeFileString(outputs, encode([null, { verdict: "built" }]))
            .pipe(Effect.orDie);
          const set = {
            FAKE_HERDR_OUTPUTS: outputs,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const before = Rec.fromEntries(
                Arr.map(Rec.keys(set), (key) => [key, Bun.env[key]] as const),
              );
              Object.assign(Bun.env, set);
              return before;
            }),
            (before) =>
              Effect.sync(() => {
                for (const [key, value] of Rec.toEntries(before))
                  if (value === undefined) delete Bun.env[key];
                  else Bun.env[key] = value;
              }),
          );
          resetExecutors();
          const env = readEnv({
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            HOME: world.home,
            COLLIE_CWD: world.project,
          });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "reuses",
              request: "start",
              input: { work: "it" },
            })
            .pipe(Effect.orDie);
          const launched = decodeLaunched(
            yield* until(
              () =>
                fs
                  .readFileString(`${world.state}/agents/${runId}/first-step.launch.json`)
                  .pipe(Effect.orElseSucceed(() => "")),
              (one) => one !== "",
            ),
          );
          // It asks once it has its prompt, as an agent does.
          yield* until(
            () => deliveriesOf(world.state, runId),
            (lines) =>
              Arr.some(
                lines,
                (one) => one.delivery.cause.kind === "step" && SENT_STATES.has(one.delivery.state),
              ),
          );
          yield* recordClaudeEvent(yield* controlDir(world.state, launched.agent), asked).pipe(
            Effect.orDie,
          );
          const waiting = () =>
            client.run({ runId }).pipe(
              Effect.orDie,
              Effect.map((view) => view?.waiting ?? []),
            );
          const [question] = yield* until(waiting, (rows) => rows.length === 1);
          const name = question!.name;

          const [steered] = yield* carryOutAsked(
            env,
            [
              {
                kind: "deliver",
                run: runId,
                agent: launched.agent,
                text: "Use SQLite and carry on",
                mode: "boundary",
              },
            ],
            { origin: "desktop", requestId: "desktop-1" },
          );
          expect(steered).toMatchObject({ kind: "deliver", state: "applied" });
          const [row] = yield* waiting();
          expect(row).toMatchObject({ name, answer: null });
          expect(row?.superseded ?? null).not.toBeNull();

          const printed = yield* collie(world, ["board"]);
          const { tasks } = yield* Schema.decodeUnknownEffect(Board)(printed.envelope.data).pipe(
            Effect.orDie,
          );
          const card = Arr.findFirst(tasks, (task) => task.run === runId);
          expect(card._tag === "Some" ? card.value.decision : "no card").toBeNull();

          const answered = yield* collie(world, [
            "run",
            "answer",
            runId,
            "Postgres",
            "--decision",
            name,
          ]);
          expect(answered.envelope.ok).toBe(false);

          yield* fs
            .writeFileString(launched.output, encode({ verdict: "built" }))
            .pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) => one !== null && isSettled(one),
          );
          expect(done?.status.status).toBe("complete");
          expect(Arr.filter(done?.waiting ?? [], (one) => one.revises === name)).toEqual([]);
          const log = yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG ?? "");
          expect(Str.includes("is answered")(log)).toBe(false);
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["reuses.workflow.ts"],
    ),
  120_000,
);
