// A Claude agent's `AskUserQuestion`, put on its Run by the hook Collie installs, is
// answered the way a Workflow's question is: from `collie run answer` and from the card,
// in any words. The host here is a real one over a fake herdr.

import { recordsAt, launchOf } from "./support/records";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { connect } from "../src/host";
import { readEnv } from "../src/env";
import { resetExecutors } from "../src/executors";
import { isSettled } from "../src/lifecycle";
import { carryOutAsked } from "../src/run-actions";
import { controlDir } from "../src/compaction";
import { recordClaudeEvent } from "../src/compactors";
import { TaskView } from "../src/board-model";
import { piExtension } from "../src/chat";
import { piQuestionTool } from "../src/compactors";
import { askWith, piTools } from "./support/pi";
import { stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const asking = (id: string, questions: ReadonlyArray<unknown>) =>
  encode({
    session_id: "s-1",
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: id,
    tool_input: { questions },
  });

const askedTwo = asking("toolu_1", [
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
  {
    question: "Which checks?",
    header: "Checks",
    options: [
      { label: "lint and typecheck (Recommended)", description: "both gates" },
      { label: "lint", description: "oxlint" },
      { label: "none", description: "CI runs them" },
    ],
    multiSelect: false,
  },
]);

const askedOne = asking("toolu_2", [
  {
    question: "Which region?",
    header: "Region",
    options: [
      { label: "eu-west (Recommended)", description: "near the users" },
      { label: "us-east", description: "near the team" },
      { label: "Postgres", description: "where the ledger is" },
    ],
    multiSelect: false,
  },
]);

const YES_NO = [
  {
    question: "May I force-push the MR branch?",
    header: "Force-push",
    options: [{ label: "Yes" }, { label: "No" }],
    multiSelect: false,
  },
];

const PATHS = [
  {
    question: "May I force-push the MR branch?",
    header: "Force-push",
    options: [
      {
        label: "Push a merge commit instead",
        description: "Keeps the history; the MR shows a merge.",
      },
      {
        label: "Force-push the rebased branch (Recommended)",
        description: "Rewrites the MR's history; reviewers lose their inline anchors.",
      },
      {
        label: "Leave the branch and stop here",
        description: "Nothing is pushed; you rebase by hand.",
      },
    ],
    multiSelect: false,
  },
];

const Hooked = Schema.fromJsonString(
  Schema.Struct({
    hookSpecificOutput: Schema.Struct({
      permissionDecision: Schema.String,
      permissionDecisionReason: Schema.String,
    }),
  }),
);
const toldBy = flow(
  Schema.decodeUnknownResult(Hooked),
  Result.getOrThrow,
  (one) => one.hookSpecificOutput,
);

const Board = Schema.Struct({ tasks: Schema.Array(TaskView) });

const boardQuestions = (world: World, runId: string) =>
  Effect.gen(function* () {
    const printed = yield* collie(world, ["board"]);
    const { tasks } = yield* Schema.decodeUnknownEffect(Board)(printed.envelope.data).pipe(
      Effect.orDie,
    );
    return Arr.flatMap(tasks, (task) => (task.run === runId ? (task.questions ?? []) : []));
  });

const SHORT_TWICE =
  "The agent gave 2 options and no recommendation; Collie asked for at least three options and exactly one recommended option.";

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
          const launched = (yield* until(
            () => launchOf(world.state, runId, "build"),
            (one) => one !== undefined,
          ))!;
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
            "sqlite",
            "--decision",
            "ask-build-1",
          ]);
          expect(answered.envelope).toMatchObject({
            ok: true,
            data: { decision: "ask-build-1", value: "2" },
          });
          const [carded] = yield* carryOutAsked(
            env,
            [{ kind: "answer", run: runId, choiceId: "ask-build-2", answer: "1" }],
            { origin: "board", requestId: "card-1" },
          );
          expect(carded).toMatchObject({ kind: "answer", state: "applied" });

          const log = Bun.env.FAKE_HERDR_LOG ?? "";
          const prompts = yield* until(
            () => fs.readFileString(log).pipe(Effect.orElseSucceed(() => "")),
            (all) =>
              pipe_(all, Str.includes("Your question Checks is answered:")) &&
              pipe_(all, Str.includes("Your question Database is answered:")),
          );
          expect(prompts).toMatch(
            /From cli, [^\n]*\.\\nYour question Database is answered: SQLite/,
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
        }).pipe(Effect.provide(recordsAt(world.state)), Effect.ensuring(stopHost(world.state))),
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
          const launched = (yield* launchOf(world.state, runId, "build"))!;

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
        }).pipe(Effect.provide(recordsAt(world.state)), Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);

const launchedRun = Effect.fn("test.launchedRun")(function* (world: World, client: Client) {
  const { runId } = yield* client
    .start({ project: world.project, id: "told", request: "start", input: { work: "it" } })
    .pipe(Effect.orDie);
  const launched = (yield* until(
    () => launchOf(world.state, runId, "build"),
    (one) => one !== undefined,
  ))!;
  return { runId, launched, dir: yield* controlDir(world.state, launched.agent) };
});

type Client = Effect.Success<ReturnType<typeof connect>>;

const openOf = (client: Client, runId: string) =>
  until(
    () => client.run({ runId }).pipe(Effect.orDie),
    (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
  ).pipe(Effect.map((view) => Arr.filter(view?.waiting ?? [], (one) => one.answer === null)));

test(
  "a yes/no question is repaired once, and the paths the agent asks next reach the Run recommended first",
  () =>
    proves(
      "collie-agent-repair-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { client } = yield* hostedOver(world, [null]);
          const { runId, launched, dir } = yield* launchedRun(world, client);

          const repair = toldBy(
            yield* recordClaudeEvent(dir, asking("toolu_1", YES_NO)).pipe(Effect.orDie),
          );
          expect(repair.permissionDecision).toBe("deny");
          expect(repair.permissionDecisionReason).toContain(
            'exactly one option whose label ends " (Recommended)"',
          );
          expect(repair.permissionDecisionReason).toContain("at least three options");
          expect(repair.permissionDecisionReason).toContain("proceed, defer, or change approach");
          expect(repair.permissionDecisionReason).not.toContain("on your Run");

          const posted = toldBy(
            yield* recordClaudeEvent(dir, asking("toolu_2", PATHS)).pipe(Effect.orDie),
          );
          expect(posted.permissionDecisionReason).toContain("on your Run");
          const open = yield* openOf(client, runId);
          expect(open).toMatchObject([
            {
              name: "ask-build-1",
              prompt: "Force-push: May I force-push the MR branch?",
              options: [
                {
                  id: "1",
                  title: "Force-push the rebased branch",
                  detail: "Rewrites the MR's history; reviewers lose their inline anchors.",
                  recommended: true,
                },
                {
                  id: "2",
                  title: "Push a merge commit instead",
                  detail: "Keeps the history; the MR shows a merge.",
                },
                {
                  id: "3",
                  title: "Leave the branch and stop here",
                  detail: "Nothing is pushed; you rebase by hand.",
                },
              ],
              shortfall: null,
            },
          ]);
          expect(open[0]?.options[1]?.recommended).toBeUndefined();
          // herdr's live agents are read again at the board's next tick.
          const steering = yield* until(
            () => boardQuestions(world, runId),
            (questions) => questions[0]?.steer?.agent != null,
          );
          expect(Arr.map(steering, (one) => one.steer)).toEqual([
            { agent: launched.agent, why: null },
          ]);

          const words = yield* collie(world, [
            "run",
            "answer",
            runId,
            "just push it",
            "--decision",
            "ask-build-1",
          ]);
          expect(words.envelope.error?.message).toContain(
            '"just push it" is not one of Force-push the rebased branch, Push a merge commit instead, Leave the branch and stop here',
          );
          const picked = yield* collie(world, [
            "run",
            "answer",
            runId,
            "2",
            "--decision",
            "ask-build-1",
          ]);
          expect(picked.envelope).toMatchObject({ ok: true, data: { value: "2" } });
          yield* until(
            () =>
              fs.readFileString(Bun.env.FAKE_HERDR_LOG ?? "").pipe(Effect.orElseSucceed(() => "")),
            (all) =>
              pipe_(
                all,
                Str.includes("Your question Force-push is answered: Push a merge commit instead"),
              ),
          );
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);

test(
  "a question still short after its repair is posted flagged, and a multiSelect one is repaired into one decision each",
  () =>
    proves(
      "collie-agent-short-",
      (world) =>
        Effect.gen(function* () {
          const { client } = yield* hostedOver(world, [null]);
          const { runId, dir } = yield* launchedRun(world, client);

          const first = toldBy(
            yield* recordClaudeEvent(dir, asking("toolu_1", YES_NO)).pipe(Effect.orDie),
          );
          expect(first.permissionDecisionReason).not.toContain("on your Run");
          const again = toldBy(
            yield* recordClaudeEvent(dir, asking("toolu_2", YES_NO)).pipe(Effect.orDie),
          );
          expect(again.permissionDecisionReason).toContain("on your Run");
          expect(yield* openOf(client, runId)).toMatchObject([
            {
              name: "ask-build-1",
              options: [
                { id: "1", title: "Yes" },
                { id: "2", title: "No" },
              ],
              shortfall: SHORT_TWICE,
            },
          ]);

          const many = toldBy(
            yield* recordClaudeEvent(
              dir,
              asking("toolu_3", [{ ...PATHS[0], header: "Checks", multiSelect: true }]),
            ).pipe(Effect.orDie),
          );
          expect(many.permissionDecision).toBe("deny");
          expect(many.permissionDecisionReason).toContain("one decision per question");
          expect(many.permissionDecisionReason).not.toContain("on your Run");
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);

test(
  "a question an older host posted in words is answered to the agent in those words, not by position",
  () =>
    proves(
      "collie-agent-legacy-answer-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { client } = yield* hostedOver(world, [null]);
          const { runId, dir } = yield* launchedRun(world, client);
          const db = new Database(`${world.state}/host.db`);
          db.run(
            `INSERT INTO collie_decisions (run, decision, prompt, options, asked, asker)
             VALUES (?, 'ask-build-1', 'Workers: How many workers? (8 | 2 | 4)', '[]', ?, 'build')`,
            [runId, "2026-01-01T00:00:00.000Z"],
          );
          db.close();
          yield* recordClaudeEvent(
            dir,
            asking("toolu_1", [
              {
                question: "How many workers?",
                header: "Workers",
                options: [{ label: "8" }, { label: "2 (Recommended)" }, { label: "4" }],
                multiSelect: false,
              },
            ]),
          ).pipe(Effect.orDie);
          yield* openOf(client, runId);
          const answered = yield* collie(world, [
            "run",
            "answer",
            runId,
            "2",
            "--decision",
            "ask-build-1",
          ]);
          expect(answered.envelope).toMatchObject({ ok: true, data: { value: "2" } });
          const prompts = yield* until(
            () =>
              fs.readFileString(Bun.env.FAKE_HERDR_LOG ?? "").pipe(Effect.orElseSucceed(() => "")),
            (all) => pipe_(all, Str.includes("Your question Workers is answered:")),
          );
          expect(prompts).toContain("Your question Workers is answered: 2");
          expect(prompts).not.toContain("Your question Workers is answered: 8");
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);

test(
  "pi's question tool returns the repair for a short question, and posts its next call flagged",
  () =>
    proves(
      "collie-pi-repair-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { client } = yield* hostedOver(world, [null]);
          const { runId, launched, dir } = yield* launchedRun(world, client);
          const self = [process.execPath, `${import.meta.dir}/../src/main.ts`];
          const file = `${world.state}/${launched.agent}.tools.ts`;
          yield* fs.writeFileString(
            file,
            piExtension(self, [], {}, world.state, "news.jsonl", piQuestionTool(self, dir)),
          );
          const tools = yield* piTools(file);

          const repair = yield* askWith(tools, "call_1", YES_NO, "pi-session-1");
          expect(repair).toContain("at least three options");
          expect(repair).not.toContain("on your Run");
          const posted = yield* askWith(tools, "call_2", YES_NO, "pi-session-1");
          expect(posted).toContain("on your Run");
          const open = yield* openOf(client, runId);
          expect(Arr.map(open, (one) => [one.name, one.shortfall])).toEqual([
            ["ask-build-1", SHORT_TWICE],
          ]);
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);
