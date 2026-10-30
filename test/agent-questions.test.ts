// A Claude agent's `AskUserQuestion`, put on its Run by the hook Collie installs, is
// answered the way a Workflow's question is: from `collie run answer` and from the card,
// in any words. The host here is a real one over a fake herdr.

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
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
import { stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const decodeLaunched = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Launched)),
  Result.getOrThrow,
);

const askedTwo = encode({
  session_id: "s-1",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_1",
  tool_input: {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        options: [{ label: "Postgres", description: "the one ops runs" }],
        multiSelect: false,
      },
      {
        question: "Which checks?",
        header: "Checks",
        options: [{ label: "lint", description: "oxlint" }],
        multiSelect: true,
      },
    ],
  },
});

const askedOne = encode({
  session_id: "s-1",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_2",
  tool_input: {
    questions: [{ question: "Which region?", header: "Region", options: [], multiSelect: false }],
  },
});

/**
 * A host for this world over a fake herdr whose agent answers its prompts with `outputs`,
 * and the env the board's actions are carried out in.
 */
const hostedOver = Effect.fn("test.hostedOver")(function* (
  world: World,
  outputs: ReadonlyArray<unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${world.home}/outputs.json`;
  yield* fs.writeFileString(file, encode(outputs)).pipe(Effect.orDie);
  // The host a client spawns inherits this process's environment: it has to own this
  // world's state, never the operator's.
  const set = {
    FAKE_HERDR_OUTPUTS: file,
    HERDR_PLUGIN_STATE_DIR: world.state,
    COLLIE_USER_DIR: world.config,
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const before = Rec.fromEntries(Arr.map(Rec.keys(set), (key) => [key, Bun.env[key]] as const));
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
  return { env, client: yield* connect(world.state).pipe(Effect.orDie) };
});

test(
  "an agent's questions are answered from the CLI and the card, and each answer reaches it under its own sender",
  () =>
    proves(
      "collie-agent-question-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { env, client } = yield* hostedOver(world, [null]);
          const { runId } = yield* client
            .start({ project: world.project, id: "told", request: "start", input: { work: "it" } })
            .pipe(Effect.orDie);
          const record = `${world.state}/agents/${runId}/build.launch.json`;
          const text = yield* until(
            () => fs.readFileString(record).pipe(Effect.orElseSucceed(() => "")),
            (one) => one !== "",
          );
          const launched = decodeLaunched(text);
          yield* recordClaudeEvent(yield* controlDir(world.state, launched.agent), askedTwo).pipe(
            Effect.orDie,
          );
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => (view?.waiting.length ?? 0) === 2,
          );

          const answered = yield* collie(world, [
            "run",
            "answer",
            runId,
            "SQLite; it is only a demo",
            "--decision",
            "ask-build-1",
          ]);
          expect(answered.envelope).toMatchObject({
            ok: true,
            data: { decision: "ask-build-1", value: "SQLite; it is only a demo" },
          });
          const [carded] = yield* carryOutAsked(
            env,
            [{ kind: "answer", run: runId, choiceId: "ask-build-2", answer: "lint and typecheck" }],
            { origin: "board", requestId: "card-1" },
          );
          expect(carded).toMatchObject({ kind: "answer", state: "applied" });

          const log = Bun.env.FAKE_HERDR_LOG ?? "";
          const prompts = yield* until(
            () => fs.readFileString(log).pipe(Effect.orElseSucceed(() => "")),
            (all) => pipe_(all, Str.includes("Your question Checks is answered:")),
          );
          expect(prompts).toMatch(
            /From cli, [^\n]*\.\\nYour question Database is answered: SQLite; it is only a demo/,
          );
          expect(prompts).toMatch(
            /From the human, on the board, [^\n]*\.\\nYour question Checks is answered: lint and typecheck/,
          );

          yield* recordClaudeEvent(yield* controlDir(world.state, launched.agent), askedOne).pipe(
            Effect.orDie,
          );
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => Arr.some(view?.waiting ?? [], (one) => one.name === "ask-build-3"),
          );
          const [chatted] = yield* carryOutAsked(
            env,
            [{ kind: "answer", run: runId, choiceId: "ask-build-3", answer: "Postgres" }],
            { origin: "chat", requestId: "chat-1", conversation: "c-1", said: "use postgres" },
          );
          expect(chatted).toMatchObject({ kind: "answer", state: "applied" });
          const again = yield* until(
            () => fs.readFileString(log).pipe(Effect.orElseSucceed(() => "")),
            (all) => pipe_(all, Str.includes("Your question Region is answered: Postgres")),
          );
          expect(again).toMatch(
            /From chat for the human, [^\n]*\. The human said: \\"use postgres\\"\\nYour question Region is answered: Postgres/,
          );

          yield* fs
            .writeFileString(launched.output, encode({ verdict: "built" }))
            .pipe(Effect.orDie);
          const view = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) => one !== null && isSettled(one),
          );
          expect(view?.status.status).toBe("complete");
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);

test(
  "a question from a succeeded Run's agent after a steer is a Choice, and its answer reaches the agent",
  () =>
    proves(
      "collie-finished-question-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { env, client } = yield* hostedOver(world, [{ verdict: "built" }]);
          const { runId } = yield* client
            .start({ project: world.project, id: "told", request: "start", input: { work: "it" } })
            .pipe(Effect.orDie);
          const view = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) => one !== null && isSettled(one),
          );
          expect(view?.status.status).toBe("complete");
          const launched = decodeLaunched(
            yield* fs.readFileString(`${world.state}/agents/${runId}/build.launch.json`),
          );

          const [steered] = yield* carryOutAsked(
            env,
            [
              {
                kind: "deliver",
                run: runId,
                agent: launched.agent,
                text: "test the merge request",
                mode: "boundary",
              },
            ],
            { origin: "chat", requestId: "chat-steer" },
          );
          expect(steered).toMatchObject({ kind: "deliver", state: "applied" });
          const printed = yield* recordClaudeEvent(
            yield* controlDir(world.state, launched.agent),
            askedOne,
          ).pipe(Effect.orDie);
          expect(printed).toContain("on your Run");

          const asked = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) => Arr.some(one?.waiting ?? [], (question) => question.answer === null),
          );
          const [open] = Arr.filter(asked?.waiting ?? [], (question) => question.answer === null);
          expect(open?.prompt).toContain("Which region?");

          const [answered] = yield* carryOutAsked(
            env,
            [{ kind: "answer", run: runId, choiceId: open!.name, answer: "eu-west" }],
            { origin: "board", requestId: "card-finished" },
          );
          expect(answered).toMatchObject({ kind: "answer", state: "applied" });
          yield* until(
            () =>
              fs.readFileString(Bun.env.FAKE_HERDR_LOG ?? "").pipe(Effect.orElseSucceed(() => "")),
            (all) => pipe_(all, Str.includes("Your question Region is answered: eu-west")),
          );
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);
