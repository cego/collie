// A board question, read and answered by Desktop's questionnaire over a real bridge to a
// real host: what the human picks goes out as Desktop's own action, and what the host
// replies is what the dialog then says.

import { Database } from "bun:sqlite";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Config, Effect, Exit, Option, Schema, Stream, flow, Result } from "effect";
import { readAudit } from "../src/audit";
import type { Question } from "../src/board-model";
import { runDir } from "../src/engine";
import { act, bridgeCommand, type Door, openBridge } from "../desktop/src/bun/machine";
import type { Attempted } from "../desktop/src/bun/sent";
import { failureOf } from "../desktop/src/shared/actions";
import {
  type Event,
  HOLD,
  type Questionnaire,
  questionnaire,
  questionnaireView,
  stepped,
} from "../desktop/src/shared/questionnaire";
import { suiteEnv } from "./support/effect";
import { root, stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const doorOf = Effect.fn("test.doorOf")(function* (world: World, client = "mk-pc") {
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`];
  const desktop = yield* openBridge(bridgeCommand(command, client), {
    PATH: "/usr/bin:/bin",
    HOME: world.home,
    HERDR_PLUGIN_ROOT: world.install,
    HERDR_PLUGIN_STATE_DIR: world.state,
    COLLIE_USER_DIR: world.config,
    COLLIE_HOST: encode(command),
    ...(yield* suiteEnv),
    HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH ?? "",
    FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG ?? "",
  });
  return { machine: { profile: "local", name: client }, desktop };
});

const questionsOn = (door: Door, runId: string) =>
  Stream.runHead(door.board()).pipe(
    Effect.map((first) =>
      Option.isSome(first) && first.value._tag === "Snapshot"
        ? Arr.flatMap(first.value.tasks, (task) =>
            task.run === runId ? (task.questions ?? []) : [],
          )
        : [],
    ),
    Effect.orDie,
  );
const questionOn = (door: Door, runId: string, id: string) =>
  until(
    () => questionsOn(door, runId),
    (questions) => Arr.some(questions, (one) => one.id === id),
  ).pipe(
    Effect.map((questions) => Option.getOrThrow(Arr.findFirst(questions, (one) => one.id === id))),
  );

const started = (door: Door, world: World, goal: string) =>
  door
    .start({ project: world.project, id: "choices", request: `start-${goal}`, input: { goal } })
    .pipe(
      Effect.orDie,
      Effect.map(({ runId }) => runId),
    );

const through = (state: Questionnaire, events: ReadonlyArray<Event>) =>
  Arr.reduce(events, state, (now, event) => stepped(now, event).state);

/**
 * Submits what is checked over `reached` as Desktop's action runner would, under the request
 * the questionnaire keeps, and settles it with the host's reply.
 */
const submitted = Effect.fn("test.submitted")(function* (
  reached: Effect.Success<ReturnType<typeof doorOf>>,
  state: Questionnaire,
  offered: string,
  kind: "submit" | "steer" = "submit",
  log: Array<Attempted> = [],
) {
  const { state: sending, does } = stepped(state, { kind, request: offered });
  if (does?.kind !== "send") return { state: sending, request: null, failed: null };
  const exit = yield* act(reached, does.request, does.action, (line) =>
    Effect.sync(() => log.push(line)),
  ).pipe(Effect.exit);
  if (Exit.isSuccess(exit))
    return {
      state: stepped(sending, {
        kind: "replied",
        request: does.request,
        ok: true,
        fresh: !Arr.some(log, (line) => line.ended === "repeat"),
      }).state,
      request: does.request,
      failed: null,
    };
  const failed = failureOf(exit.cause);
  return {
    state: stepped(sending, {
      kind: "replied",
      request: does.request,
      ok: false,
      refused: failed.refused === true,
      reason: failed.reason,
    }).state,
    request: does.request,
    failed,
  };
});

const answersIn = (world: World, runId: string) =>
  readAudit(runDir(world.state, runId)).pipe(
    Effect.map((lines) => Arr.filter(lines, (line) => line.operation === "answer")),
    Effect.orDie,
  );

test(
  "an Answer retried under its request after the door renews records one answer, and reads answered",
  () =>
    proves(
      "collie-questionnaire-retry-",
      (world) =>
        Effect.gen(function* () {
          const first = yield* doorOf(world);
          const runId = yield* started(first.desktop, world, "three");
          const question = yield* questionOn(first.desktop, runId, "pick");
          const picked = through(questionnaire(question), [{ kind: "pick", id: "wait" }]);

          const log: Array<Attempted> = [];
          const once = yield* submitted(first, picked, "answer-1", "submit", log);
          expect(once.request).toBe("answer-1");
          // The reply was lost with the door: Desktop knows only that the connection renewed.
          const lost = stepped(stepped(picked, { kind: "submit", request: "answer-1" }).state, {
            kind: "replied",
            request: "answer-1",
            ok: false,
            refused: false,
            reason: "mk-pc's connection was renewed before this finished",
          }).state;

          const renewed = yield* doorOf(world);
          const again = yield* submitted(renewed, lost, "answer-2", "submit", log);
          expect(again.request).toBe("answer-1");
          expect(Arr.map(log, (line) => line.ended)).toEqual(["accepted", "repeat"]);
          expect(questionnaireView(again.state).status).toBe("Answered: wait");
          expect((yield* answersIn(world, runId)).length).toBe(1);
          yield* stopHost(world.state);
        }),
      ["choices.workflow.ts"],
    ),
  120_000,
);

test(
  "two Desktops racing on one question: one is answered, the other shows the refusal naming who answered",
  () =>
    proves(
      "collie-questionnaire-race-",
      (world) =>
        Effect.gen(function* () {
          const pc = yield* doorOf(world, "mk-pc");
          const laptop = yield* doorOf(world, "mk-laptop");
          const runId = yield* started(pc.desktop, world, "three");
          const question = yield* questionOn(pc.desktop, runId, "pick");
          const [one, other] = yield* Effect.all(
            [
              submitted(
                pc,
                through(questionnaire(question), [{ kind: "pick", id: "ship" }]),
                "pc-1",
              ),
              submitted(
                laptop,
                through(questionnaire(question), [{ kind: "pick", id: "drop" }]),
                "laptop-1",
              ),
            ],
            { concurrency: "unbounded" },
          );
          const said = Arr.map([one, other], (sent) => questionnaireView(sent.state).status);
          const answered = Arr.filter(
            said,
            (line) => line !== null && Str.startsWith("Answered: ")(line),
          );
          const refused = Arr.filter([one, other], (sent) => sent.failed !== null);
          expect(answered).toHaveLength(1);
          expect(refused).toHaveLength(1);
          const reason = refused[0]!.failed!.reason;
          expect(reason).toContain('"pick" was already answered');
          expect(reason).toContain("by Desktop");
          expect(refused[0]!.failed!.refused).toBe(true);
          expect(questionnaireView(refused[0]!.state).status).toBe(reason);
          expect(
            Arr.filter(questionnaireView(refused[0]!.state).rows, (row) => row.checked),
          ).toHaveLength(1);
          expect((yield* answersIn(world, runId)).length).toBe(1);
          yield* stopHost(world.state);
        }),
      ["choices.workflow.ts"],
    ),
  120_000,
);

test(
  "Desktop's Hold on a two-option Choice holds the Run and leaves it open, and a later Answer settles it",
  () =>
    proves(
      "collie-questionnaire-hold-",
      (world) =>
        Effect.gen(function* () {
          const reached = yield* doorOf(world);
          const runId = yield* started(reached.desktop, world, "two");
          const question = yield* questionOn(reached.desktop, runId, "pick");
          expect(question.hold).toEqual({ offered: true, why: null });

          const held = yield* submitted(
            reached,
            through(questionnaire(question), [{ kind: "pick", id: HOLD }]),
            "hold-1",
          );
          expect(held.failed).toBeNull();
          expect(questionnaireView(held.state).status).toBe("Run held · question still open");
          const audit = yield* readAudit(runDir(world.state, runId)).pipe(Effect.orDie);
          expect(
            Option.getOrUndefined(Arr.findFirst(audit, (line) => line.operation === "hold"))
              ?.reason,
          ).toBe("held at question pick");

          const still = yield* until(
            () => questionOn(reached.desktop, runId, "pick"),
            (one) => one.hold?.offered === false,
          );
          expect(still.hold).toEqual({ offered: false, why: "Run already held" });
          const shown = yield* collie(world, ["run", "show", runId]);
          expect(shown.envelope.data).toMatchObject({
            run: { waiting: [{ name: "pick", answer: null }] },
          });

          const seen = stepped(held.state, { kind: "seen", question: still }).state;
          const answered = yield* submitted(
            reached,
            through(seen, [{ kind: "pick", id: "go" }]),
            "answer-1",
          );
          expect(answered.failed).toBeNull();
          expect(questionnaireView(answered.state).status).toBe("Answered: Go on");
          expect(Arr.map(yield* answersIn(world, runId), (line) => line.actor.requestId)).toEqual([
            "answer-1",
          ]);
          yield* stopHost(world.state);
        }),
      ["choices.workflow.ts"],
    ),
  120_000,
);

test(
  "rows an older host wrote reach the questionnaire over the bridge: no badge, no Hold, answered by title and by words",
  () =>
    proves(
      "collie-questionnaire-legacy-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* Effect.scoped(
            Effect.gen(function* () {
              const reached = yield* doorOf(world);
              const id = yield* started(reached.desktop, world, "three");
              yield* questionOn(reached.desktop, id, "pick");
              return id;
            }),
          );
          yield* stopHost(world.state);
          const db = new Database(`${world.state}/host.db`);
          db.run(
            `INSERT INTO collie_decisions (run, decision, prompt, options, asked, asker)
             VALUES (?, 'ask-op-1', 'Region: Which region?', '["eu-west","us-east"]', ?, 'op')`,
            [runId, "2026-01-01T00:00:00.000Z"],
          );
          db.run(
            `INSERT INTO collie_decisions (run, decision, prompt, options, asked, asker)
             VALUES (?, 'ask-op-2', 'Which team should own it?', '[]', ?, 'op')`,
            [runId, "2026-01-01T00:00:01.000Z"],
          );
          db.close();

          const reached = yield* doorOf(world);
          const titled = yield* questionOn(reached.desktop, runId, "ask-op-1");
          const worded = yield* questionOn(reached.desktop, runId, "ask-op-2");
          const shown = (one: Question) => {
            const view = questionnaireView(questionnaire(one));
            return {
              words: view.words,
              rows: Arr.map(view.rows, (row) => row.title),
              badges: Arr.filter(view.rows, (row) => row.recommended).length,
            };
          };
          expect(shown(titled)).toEqual({ words: false, rows: ["eu-west", "us-east"], badges: 0 });
          expect(shown(worded)).toEqual({ words: true, rows: [], badges: 0 });

          const byTitle = yield* submitted(
            reached,
            through(questionnaire(titled), [{ kind: "pick", id: "eu-west" }]),
            "answer-1",
          );
          expect(questionnaireView(byTitle.state).status).toBe("Answered: eu-west");
          const byWords = yield* submitted(
            reached,
            through(questionnaire(worded), [{ kind: "type", text: "platform, the infra team" }]),
            "answer-2",
          );
          expect(questionnaireView(byWords.state).status).toBe(
            "Answered: platform, the infra team",
          );
          const shownAfter = yield* collie(world, ["run", "show", runId]);
          expect(shownAfter.envelope.data).toMatchObject({
            run: {
              waiting: expect.arrayContaining([
                expect.objectContaining({ name: "ask-op-1", answer: "eu-west" }),
                expect.objectContaining({ name: "ask-op-2", answer: "platform, the infra team" }),
              ]),
            },
          });
          yield* stopHost(world.state);
        }),
      ["choices.workflow.ts"],
    ),
  120_000,
);
