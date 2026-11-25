import type { Records } from "../src/records";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect";
import { expect, setDefaultTimeout, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Config, Duration, Effect, FileSystem, Option, Schema, flow, Result } from "effect";
import type { Scope } from "effect";
import { act, bridgeCommand, openBridge } from "../desktop/src/bun/machine";
import { questionnaire, questionnaireView, stepped } from "../desktop/src/shared/questionnaire";
import { readEnv } from "../src/env";
import type { PluginEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { resetExecutors } from "../src/executors";
import { connect } from "../src/host";
import { carryOutAsked } from "../src/run-actions";
import { SENT_STATES, appendLine } from "../src/steering";
import { deliveredTo, hostRecords, recordsAt } from "./support/records";
import { readMetrics } from "../src/metrics";
import { NOTIFIED, RunRecords } from "../src/run-records";
import { TaskView } from "../src/board-model";
import { read as readProposals, record as recordProposal } from "../src/proposals";
import type { Actor } from "../src/proposals";
import { agentName } from "../src/naming";
import { controlDir } from "../src/compaction";
import { recordClaudeEvent } from "../src/compactors";
import { epochMs, nowIso } from "../src/time";
import { suiteEnv } from "./support/effect";
import { root, stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";
import type { World } from "./support/world";
import type { FakeHc } from "./support/fake-hc";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
// WARNING: a restart runs the host's own recovery, which outlasts the default timeout.
setDefaultTimeout(90_000);
const Board = Schema.Struct({ tasks: Schema.Array(TaskView) });

const PICKS = [{ label: "Postgres (Recommended)" }, { label: "SQLite" }, { label: "JSONL" }];

const GRACE_MS = 3000;
const TICK_MS = 500;
// WARNING: Must exceed the grace and two board ticks, or no revision has opened yet.
const SETTLED = Duration.millis(GRACE_MS + 4 * TICK_MS);

type Client = Effect.Success<ReturnType<typeof connect>>;

interface AtQuestion {
  readonly world: World;
  readonly env: PluginEnv;
  readonly client: Client;
  readonly runId: string;
  readonly agent: string;
  readonly agents: ReadonlyArray<string>;
  readonly status: (status: string, agent?: string) => Effect.Effect<void>;
}

interface Setup {
  readonly mode: "declared" | "pair" | "moves";
  readonly task?: string;
  readonly awaiting?: "question" | "step";
}

const startHost = (world: World) => connect(world.state).pipe(Effect.orDie);

let core: FakeHc;

const waitingRun = Effect.fn("test.waitingRun")(function* (
  world: World,
  client: Client,
  request: string,
  setup: Setup = { mode: "declared" },
) {
  const { runId } = yield* client
    .start({
      project: world.project,
      id: "stepped",
      request,
      input: { mode: setup.mode, gates: world.home },
      task: setup.task,
    })
    .pipe(Effect.orDie);
  const agents = Arr.map(setup.mode === "pair" ? ["build", "check"] : ["build"], (step) =>
    agentName(runId, step, null, 1),
  );
  const listed = () =>
    new Herdr(readEnv({ HC_SOCKET: core.socketPath })).agentList().pipe(Effect.orDie);
  // WARNING: a question asked before the launch is recorded is before the point its Run reads from.
  const taken = () =>
    deliveredTo(world.state, runId).pipe(
      Effect.map((rows) =>
        Arr.some(rows, (one) => one.cause.kind === "step" && one.state !== "reserved"),
      ),
      Effect.orElseSucceed(() => false),
    );
  yield* until(
    () =>
      setup.awaiting === "step"
        ? Effect.gen(function* () {
            return (
              (yield* taken()) && Arr.some(yield* listed(), (one) => one.name === agents.at(-1))
            );
          })
        : client.run({ runId }).pipe(
            Effect.orDie,
            Effect.map(
              (view) =>
                view?.status.status === "suspended" &&
                Arr.some(view.waiting, (one) => one.name === "go" && one.answer === null),
            ),
          ),
    (ready) => ready,
  );
  expect(Arr.map(yield* listed(), (one) => one.name)).toEqual(expect.arrayContaining(agents));
  return { runId, agent: agents.at(-1)!, agents };
});

const atQuestion = <A, E>(
  prefix: string,
  body: (at: AtQuestion) => Effect.Effect<A, E, PlatformServices | Records | Scope.Scope>,
  setup: Setup = { mode: "declared" },
) =>
  proves(
    prefix,
    (world, worldCore) =>
      Effect.gen(function* () {
        core = worldCore;
        resetExecutors();
        const fs = yield* FileSystem.FileSystem;
        const outputs = `${world.home}/outputs.json`;
        yield* fs
          .writeFileString(
            outputs,
            encode(
              setup.awaiting === "step"
                ? [
                    { writes: [], output: null, owed: true },
                    ...Arr.makeBy(6, () => ({ verdict: "done" })),
                  ]
                : Arr.makeBy(6, () => ({ verdict: "done" })),
            ),
          )
          .pipe(Effect.orDie);
        const set = {
          COLLIE_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          COLLIE_HOST_SUPERSEDE_GRACE_MS: String(GRACE_MS),
          COLLIE_BOARD_TICK: `${TICK_MS} millis`,
          COLLIE_RECOVERY_EVERY: `${TICK_MS} millis`,
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
              for (const [key, value] of Rec.toEntries(before)) {
                if (value === undefined) {
                  delete Bun.env[key];
                } else {
                  Bun.env[key] = value;
                }
              }
            }),
        );
        const env = readEnv({
          HC_SOCKET: core.socketPath,
          COLLIE_ROOT: world.install,
          COLLIE_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          HOME: world.home,
          COLLIE_CWD: world.project,
        });
        const client = yield* startHost(world);
        const { runId, agent, agents } = yield* waitingRun(world, client, "start", setup);
        core.reportedOnly(agents);
        const status = (said: string, one?: string) =>
          Effect.forEach(one === undefined ? agents : [one], (name) => core.report(name, said), {
            discard: true,
          });
        return yield* body({ world, env, client, runId, agent, agents, status }).pipe(
          Effect.provide(recordsAt(world.state)),
          Effect.ensuring(stopHost(world.state)),
        );
      }),
    ["stepped.workflow.ts"],
  );

const desktop: (requestId: string) => Actor = (requestId) => ({ origin: "desktop", requestId });

const tell = (at: AtQuestion, text: string, by: Actor, agent = at.agent) =>
  Effect.map(
    carryOutAsked(at.env, [{ kind: "deliver", run: at.runId, agent, text, mode: "boundary" }], by),
    ([done]) => done,
  );

const viewOf = (at: AtQuestion, client: Client = at.client) =>
  client.run({ runId: at.runId }).pipe(Effect.orDie);

const waitingOf = (at: AtQuestion, client: Client = at.client) =>
  viewOf(at, client).pipe(Effect.map((view) => view?.waiting ?? []));

const rowOf = (waiting: Effect.Success<ReturnType<typeof waitingOf>>, name: string) =>
  Option.getOrUndefined(Arr.findFirst(waiting, (one) => one.name === name));

const revisionOf = (waiting: Effect.Success<ReturnType<typeof waitingOf>>, of = "go") =>
  Option.getOrUndefined(Arr.findFirst(waiting, (one) => one.revises === of));

const answer = (at: AtQuestion, value: string, decision: string, extra = {}) =>
  collie(at.world, ["run", "answer", at.runId, value, "--decision", decision], extra);

const shipStarted = (at: AtQuestion) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs
      .exists(`${at.world.state}/agents/${at.runId}/ship.prompt.md`)
      .pipe(Effect.orElseSucceed(() => false)),
  );

const notified = (at: AtQuestion) =>
  hostRecords(
    at.world.state,
    RunRecords.use((records) => records.controlsOf(NOTIFIED, at.runId)),
  ).pipe(
    Effect.map(Arr.map((row) => row.key)),
    Effect.orElseSucceed(() => {
      const returned: ReadonlyArray<string> = [];
      return returned;
    }),
  );

const cardOf = (at: AtQuestion) =>
  Effect.gen(function* () {
    const printed = yield* collie(at.world, ["board"]);
    const { tasks } = yield* Schema.decodeUnknownEffect(Board)(printed.envelope.data).pipe(
      Effect.orDie,
    );
    return Option.getOrUndefined(Arr.findFirst(tasks, (task) => task.run === at.runId));
  });

const supersededBy = (at: AtQuestion, text: string, request: string, agent = at.agent) =>
  Effect.gen(function* () {
    expect(yield* tell(at, text, desktop(request), agent)).toMatchObject({ state: "applied" });
    expect(rowOf(yield* waitingOf(at), "go")).toMatchObject({ answer: null });
    expect(rowOf(yield* waitingOf(at), "go")?.superseded ?? null).not.toBeNull();
    const sent = Arr.filter(
      yield* deliveredTo(at.world.state, at.runId),
      (one) => one.cause.kind === "steer" && SENT_STATES.has(one.state),
    );
    const cause = rowOf(yield* waitingOf(at), "go")?.cause;
    expect(Arr.filter(sent, (one) => one.id === cause)).toMatchObject([
      { human: { origin: "desktop" } },
    ]);
  });

test("a human's message herdr took before its host could set the question aside still sets it aside", () =>
  atQuestion("collie-supersede-missed-", (at) =>
    Effect.gen(function* () {
      const [step] = Arr.filter(
        yield* deliveredTo(at.world.state, at.runId),
        (one) => one.agent === at.agent,
      );
      yield* appendLine({
        ...step!,
        id: "missed-steer-1",
        at: yield* nowIso,
        cause: { kind: "steer", ref: "missed" },
        state: "submitted",
        human: { origin: "desktop" },
      });

      const waiting = yield* until(
        () => waitingOf(at),
        (rows) => (rowOf(rows, "go")?.superseded ?? null) !== null,
      );
      expect(rowOf(waiting, "go")).toMatchObject({ answer: null, cause: "missed-steer-1" });
    }),
  ));

test("Desktop's steering entry sends the words to the board's steer target, which sets the Choice aside with no answer", () =>
  atQuestion("collie-questionnaire-steer-", (at) =>
    Effect.gen(function* () {
      const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
      const command = Option.isSome(binary)
        ? [binary.value]
        : [process.execPath, `${root}src/main.ts`];
      const bridge = yield* openBridge(bridgeCommand(command, "mk-pc"), {
        PATH: "/usr/bin:/bin",
        HOME: at.world.home,
        COLLIE_ROOT: at.world.install,
        COLLIE_STATE_DIR: at.world.state,
        COLLIE_USER_DIR: at.world.config,
        COLLIE_HOST: encode(command),
        ...(yield* suiteEnv),
        HC_SOCKET: Bun.env.HC_SOCKET ?? "",
      });
      const reached = { machine: { profile: "local", name: "mk-pc" }, desktop: bridge };
      // WARNING: herdr's live agents are read only at the board's next tick, so wait for it.
      const card = yield* until(
        () => cardOf(at),
        (task) => task?.questions?.[0]?.steer?.agent != null,
      );
      const go = card!.questions![0]!;
      expect(go.steer).toEqual({ agent: at.agent, why: null });

      const typed = stepped(questionnaire(go), { kind: "draft", text: "Call it the chooser" });
      const { state: sending, does } = stepped(typed.state, {
        kind: "steer",
        request: "desktop-steer-1",
      });
      expect(does).toEqual({
        kind: "send",
        request: "desktop-steer-1",
        action: {
          _tag: "Deliver",
          runId: at.runId,
          agent: at.agent,
          text: "Call it the chooser",
        },
      });
      if (does?.kind !== "send") {
        return;
      }
      yield* act(reached, does.request, does.action).pipe(Effect.orDie);
      const steered = stepped(sending, {
        kind: "replied",
        request: does.request,
        ok: true,
        fresh: true,
      }).state;
      expect(questionnaireView(steered).status).toBe(
        `Sent to ${at.agent}; the question is set aside`,
      );

      const waiting = yield* until(
        () => waitingOf(at),
        (rows) => rowOf(rows, "go")?.superseded != null,
      );
      expect(rowOf(waiting, "go")).toMatchObject({ answer: null });
      expect(Arr.filter(waiting, (one) => one.answer !== null)).toEqual([]);
    }),
  ));

test("a human's Desktop message sets the question aside while its agent works, and the question is asked again after", () =>
  atQuestion("collie-supersede-replay-", (at) =>
    Effect.gen(function* () {
      const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
      const command = Option.isSome(binary)
        ? [binary.value]
        : [process.execPath, `${root}src/main.ts`];
      const bridge = yield* openBridge(bridgeCommand(command, "mk-pc"), {
        PATH: "/usr/bin:/bin",
        HOME: at.world.home,
        COLLIE_ROOT: at.world.install,
        COLLIE_STATE_DIR: at.world.state,
        COLLIE_USER_DIR: at.world.config,
        COLLIE_HOST: encode(command),
        ...(yield* suiteEnv),
        HC_SOCKET: Bun.env.HC_SOCKET ?? "",
      });
      const reached = { machine: { profile: "local", name: "mk-pc" }, desktop: bridge };
      yield* act(reached, "desktop-message-1", {
        _tag: "Deliver",
        runId: at.runId,
        agent: at.agent,
        text: "Call it the chooser",
      }).pipe(Effect.orDie);
      yield* until(
        () => deliveredTo(at.world.state, at.runId),
        (lines) =>
          Arr.some(lines, (one) => one.cause.kind === "steer" && SENT_STATES.has(one.state)),
      );
      yield* at.status("working");

      const shown = yield* collie(at.world, ["run", "show", at.runId]);
      expect(shown.envelope.data).toMatchObject({ next_action: null });
      const card = yield* cardOf(at);
      expect(card?.state).toBe("active");
      expect(card?.decision).toBeNull();
      expect(card?.questions).toEqual([]);
      expect(card?.sentence).toContain(`Working on what you told ${at.agent}`);
      expect(card?.sentence).toContain("Call it the chooser");
      const waited = yield* collie(at.world, [
        "run",
        "wait",
        at.runId,
        "--until",
        "attention",
        "--timeout",
        "2 seconds",
      ]);
      expect(waited.envelope.ok).toBe(false);

      const early = yield* answer(at, "yes", "go");
      expect(early.envelope.error?.message).toContain('"go" was superseded');
      expect(revisionOf(yield* waitingOf(at))).toBeUndefined();

      yield* at.status("idle");
      const waiting = yield* until(
        () => waitingOf(at),
        (rows) => revisionOf(rows) !== undefined,
      );
      const revision = revisionOf(waiting)!;
      expect(revision.name).not.toBe("go");
      expect(revision).toMatchObject({
        prompt: "Ship it?",
        options: [
          { id: "yes", title: "yes" },
          { id: "no", title: "no" },
        ],
        answer: null,
      });
      expect(yield* notified(at)).toContain(`needs-you:ask:${revision.name}`);

      const late = yield* answer(at, "yes", "go");
      expect(late.envelope.error?.message).toContain(`"${revision.name}"`);
      expect(yield* shipStarted(at)).toBe(false);

      expect((yield* answer(at, "yes", revision.name)).envelope).toMatchObject({ ok: true });
      yield* until(
        () => shipStarted(at),
        (started) => started,
      );
      expect(rowOf(yield* waitingOf(at), "go")).toMatchObject({ answer: null });
    }),
  ));

test("the agent the human messaged may still answer the question itself, and nobody else may", () =>
  atQuestion("collie-supersede-go-", (at) =>
    Effect.gen(function* () {
      yield* supersededBy(at, "Looks good, go ahead", "desktop-go");
      yield* at.status("working");

      const fromCli = yield* answer(at, "yes", "go");
      expect(fromCli.envelope.error?.message).toContain('"go" was superseded');
      const other = yield* waitingRun(at.world, at.client, "start-other");
      const fromOtherRun = yield* answer(at, "yes", "go", {
        COLLIE_RUN: other.runId,
        COLLIE_AGENT: other.agent,
      });
      expect(fromOtherRun.envelope.error?.message).toContain('"go" was superseded');
      expect(rowOf(yield* waitingOf(at), "go")).toMatchObject({ answer: null });
      expect(rowOf(yield* waitingOf(at), "go")?.superseded ?? null).not.toBeNull();

      const before = yield* notified(at);
      const itself = yield* collie(at.world, ["run", "answer", at.runId, "yes"], {
        COLLIE_RUN: at.runId,
        COLLIE_AGENT: at.agent,
      });
      expect(itself.envelope).toMatchObject({ ok: true, data: { decision: "go", value: "yes" } });
      yield* until(
        () => shipStarted(at),
        (started) => started,
      );

      yield* at.status("idle");
      yield* Effect.sleep(SETTLED);
      expect(revisionOf(yield* waitingOf(at))).toBeUndefined();
      expect(Arr.filter(yield* notified(at), (line) => !before.includes(line))).not.toContainEqual(
        expect.stringContaining("needs-you:ask:"),
      );
    }),
  ));

test("a message that is one of the options answers nothing, and the question is asked again only after the grace period", () =>
  atQuestion("collie-supersede-grace-", (at) =>
    Effect.gen(function* () {
      yield* supersededBy(at, "yes", "desktop-label");
      expect(revisionOf(yield* waitingOf(at))).toBeUndefined();

      const waiting = yield* until(
        () => waitingOf(at),
        (rows) => revisionOf(rows) !== undefined,
      );
      const original = rowOf(waiting, "go")!;
      const revision = revisionOf(waiting)!;
      expect(original.answer).toBeNull();
      expect(epochMs(revision.asked!) - epochMs(original.superseded!)).toBeGreaterThanOrEqual(
        GRACE_MS,
      );
      expect((yield* at.client.status({ runId: at.runId }).pipe(Effect.orDie)).status).toBe(
        "suspended",
      );
      expect(yield* shipStarted(at)).toBe(false);
    }),
  ));

test("an agent herdr cannot say the status of has not finished, so the question is not asked again yet", () =>
  atQuestion("collie-supersede-unknown-", (at) =>
    Effect.gen(function* () {
      yield* supersededBy(at, "Rework the plan", "desktop-unknown");
      yield* at.status("unknown");
      yield* Effect.sleep(SETTLED);
      expect(revisionOf(yield* waitingOf(at))).toBeUndefined();

      yield* at.status("idle");
      yield* until(
        () => waitingOf(at),
        (rows) => revisionOf(rows) !== undefined,
      );
    }),
  ));

test("a message that is not a human's supersedes nothing", () =>
  atQuestion("collie-supersede-not-human-", (at) =>
    Effect.gen(function* () {
      expect(
        (yield* collie(at.world, ["run", "steer", at.runId, "from a script", "--to", at.agent]))
          .envelope.ok,
      ).toBe(true);
      expect(
        yield* tell(at, "from an agent", {
          origin: "agent",
          requestId: "agent-deliver",
          from: { run: at.runId, agent: at.agent },
        }),
      ).toMatchObject({ state: "applied" });
      const steered = Arr.filter(
        yield* deliveredTo(at.world.state, at.runId),
        (one) => one.cause.kind === "steer" && SENT_STATES.has(one.state),
      );
      expect(steered).toHaveLength(2);

      const go = rowOf(yield* waitingOf(at), "go");
      expect(go).toMatchObject({ answer: null });
      expect(go?.superseded ?? null).toBeNull();
      const card = yield* cardOf(at);
      expect(card?.state).toBe("blocked");
      expect(card?.decision).not.toBeNull();
    }),
  ));

test("a host started again after the work ended asks the question again, and its answer moves the Run on", () =>
  atQuestion("collie-supersede-restart-", (at) =>
    Effect.gen(function* () {
      yield* supersededBy(at, "Rework the plan", "desktop-restart");
      yield* at.status("working");
      yield* stopHost(at.world.state);
      yield* at.status("idle");

      const client = yield* startHost(at.world);
      const waiting = yield* until(
        () => waitingOf(at, client),
        (rows) => revisionOf(rows) !== undefined,
      );
      const revision = revisionOf(waiting)!;
      expect((yield* answer(at, "yes", revision.name)).envelope).toMatchObject({ ok: true });
      yield* until(
        () => shipStarted(at),
        (started) => started,
      );
    }),
  ));

test("a question its Workflow no longer waits on once it is taken up again is not asked again", () =>
  atQuestion(
    "collie-supersede-moved-",
    (at) =>
      Effect.gen(function* () {
        yield* supersededBy(at, "Rework the plan", "desktop-moved");
        yield* (yield* FileSystem.FileSystem)
          .writeFileString(`${at.world.home}/moved`, "")
          .pipe(Effect.orDie);
        yield* collie(at.world, ["run", "stop", at.runId]);
        yield* collie(at.world, ["run", "resume", at.runId]);
        yield* until(
          () => waitingOf(at),
          (rows) => rowOf(rows, "other")?.answer === null,
        );
        yield* Effect.sleep(SETTLED);
        expect(revisionOf(yield* waitingOf(at))).toBeUndefined();
      }),
    { mode: "moves" },
  ));

test("a Hold still holds the work a revision's answer starts, and Proposals are untouched", () =>
  atQuestion("collie-supersede-held-", (at) =>
    Effect.gen(function* () {
      const proposals = "some-herd";
      yield* recordProposal(proposals, {
        interpretation: "stop it",
        targets: [{ run: at.runId }],
        actions: [{ kind: "stop", run: at.runId }],
        allowedNow: [],
        intentVersions: {},
        by: "evaluator:e-1",
      });
      const pending = yield* readProposals(proposals);

      expect((yield* collie(at.world, ["run", "hold", at.runId])).envelope).toMatchObject({
        ok: true,
      });
      yield* supersededBy(at, "Have another look", "desktop-held");
      expect(yield* readProposals(proposals)).toEqual(pending);

      const waiting = yield* until(
        () => waitingOf(at),
        (rows) => revisionOf(rows) !== undefined,
      );
      expect((yield* answer(at, "yes", revisionOf(waiting)!.name)).envelope).toMatchObject({
        ok: true,
      });
      yield* Effect.sleep(SETTLED);
      expect(yield* shipStarted(at)).toBe(false);

      expect((yield* collie(at.world, ["run", "release", at.runId])).envelope).toMatchObject({
        ok: true,
      });
      yield* until(
        () => shipStarted(at),
        (started) => started,
      );
      expect(yield* readProposals(proposals)).toEqual(pending);
    }),
  ));

test("a Run stopped while its agent works on the message does not ask the question again, before or after a restart", () =>
  atQuestion("collie-supersede-stopped-", (at) =>
    Effect.gen(function* () {
      yield* supersededBy(at, "Rework the plan", "desktop-stopped");
      yield* at.status("working");
      expect((yield* collie(at.world, ["run", "stop", at.runId])).envelope).toMatchObject({
        ok: true,
      });
      yield* at.status("idle");
      const before = yield* notified(at);

      const settled = Effect.gen(function* () {
        yield* Effect.sleep(SETTLED);
        expect(revisionOf(yield* waitingOf(at))).toBeUndefined();
        expect(
          Arr.filter(yield* notified(at), (line) => !before.includes(line)),
        ).not.toContainEqual(expect.stringContaining("needs-you:ask:"));
        expect((yield* cardOf(at))?.questions).toEqual([]);
      });
      yield* settled;
      yield* stopHost(at.world.state);
      yield* startHost(at.world);
      yield* settled;
    }),
  ));

const answerSends = (at: AtQuestion, needle: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(core.logPath).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((text) =>
        Arr.length(
          Arr.filter(
            Str.split(text, "\n"),
            (line) =>
              pipe(line, Str.includes('"cmd":"terminal.send"')) && pipe(line, Str.includes(needle)),
          ),
        ),
      ),
    ),
  );

for (const evidence of [
  "no-submit",
  "another-delivery",
  "another-incarnation",
  "its-own-submit",
] as const) {
  test(`an agent-owned question stays answered across a restart, with ${evidence} for its delivery`, () =>
    atQuestion(
      `collie-answered-restart-${evidence}-`,
      (at) =>
        Effect.gen(function* () {
          yield* recordClaudeEvent(
            yield* controlDir(at.world.state, at.agent),
            encode({
              session_id: at.agent,
              hook_event_name: "PreToolUse",
              tool_name: "AskUserQuestion",
              tool_use_id: `toolu-${at.agent}`,
              tool_input: {
                questions: [{ question: "Which database?", header: "DB", options: PICKS }],
              },
            }),
            null,
          ).pipe(Effect.orDie);
          yield* until(
            () => waitingOf(at),
            (rows) => rowOf(rows, "ask-build-1")?.answer === null,
          );

          core.refuse("terminal.send", "unreachable", "the core did not answer");
          expect((yield* answer(at, "SQLite", "ask-build-1")).envelope).toMatchObject({
            ok: true,
          });
          const lost = yield* until(
            () =>
              deliveredTo(at.world.state, at.runId).pipe(
                Effect.map((rows) => Arr.filter(rows, (one) => one.cause.kind === "steer")),
                Effect.orElseSucceed(() => []),
              ),
            (rows) => Arr.some(rows, (one) => one.state === "unknown"),
          ).pipe(Effect.map((rows) => Arr.findFirst(rows, (one) => one.state === "unknown")));
          core.restore("terminal.send");
          const delivery = Option.getOrThrow(lost);
          const answered = yield* until(
            () => waitingOf(at),
            (rows) => rowOf(rows, "ask-build-1")?.answer !== null,
          );
          const held = rowOf(answered, "ask-build-1")?.answer;
          expect(held).toBe("2");

          yield* at.status("idle");
          const parked = yield* until(
            () => viewOf(at),
            (view) => view?.park?.cause === "delivery-unsettled",
          );
          expect(parked?.parked).toContain(delivery.id);

          yield* stopHost(at.world.state);
          const again = yield* startHost(at.world);
          if (evidence !== "no-submit") {
            yield* recordClaudeEvent(
              yield* controlDir(at.world.state, at.agent),
              encode({
                session_id: at.agent,
                hook_event_name: "UserPromptSubmit",
                prompt: `collie-delivery:${
                  evidence === "another-delivery" ? `${delivery.id}-elsewhere` : delivery.id
                }\nYour task for this step is next.`,
              }),
              evidence === "another-incarnation" ? "not-its-terminal" : delivery.incarnation,
            ).pipe(Effect.orDie);
          }

          const rechecked = yield* until(
            () =>
              readMetrics(`${at.world.state}/evidence/${at.runId}`).pipe(
                Effect.orElseSucceed(() => []),
              ),
            (lines) =>
              Arr.some(
                lines,
                (line) =>
                  line.action === "rechecked" && pipe(line.note ?? "", Str.includes(delivery.id)),
              ),
          );
          expect(
            Option.getOrUndefined(
              Arr.findLast(
                rechecked,
                (line) =>
                  line.action === "rechecked" && pipe(line.note ?? "", Str.includes(delivery.id)),
              ),
            )?.outcome,
          ).toBe(evidence === "its-own-submit" ? "cleared" : "uncleared");

          const after = yield* until(
            () => again.run({ runId: at.runId }).pipe(Effect.orDie),
            (view) => view !== null && (view.parked != null || view.status.status === "complete"),
          );
          expect(
            Arr.filter(after?.waiting ?? [], (one) => one.name === "ask-build-1"),
          ).toHaveLength(1);
          expect(revisionOf(after?.waiting ?? [], "ask-build-1")).toBeUndefined();
          expect(rowOf(after?.waiting ?? [], "ask-build-1")?.answer).toBe(held);
          expect(yield* answerSends(at, "SQLite")).toBe(1);
          const ledger = yield* deliveredTo(at.world.state, at.runId).pipe(
            Effect.orElseSucceed(() => []),
          );
          expect(Arr.findFirst(ledger, (one) => one.id === delivery.id)).toMatchObject(
            Option.some({ state: evidence === "its-own-submit" ? "acknowledged" : "unknown" }),
          );
        }),
      { mode: "declared", awaiting: "step" },
    ));
}

const revised = (at: AtQuestion, of = "go") =>
  Effect.map(
    until(
      () => waitingOf(at),
      (rows) => revisionOf(rows, of) !== undefined,
    ),
    (rows) => revisionOf(rows, of)!,
  );

const asAgent = (at: AtQuestion, agent: string, decision: string) =>
  collie(at.world, ["run", "answer", at.runId, "yes", "--decision", decision], {
    COLLIE_RUN: at.runId,
    COLLIE_AGENT: agent,
  });

test("a question set aside is asked again only once every agent the human messaged has finished", () =>
  atQuestion(
    "collie-supersede-several-",
    (at) =>
      Effect.gen(function* () {
        const [first, second] = [at.agents[0]!, at.agents[1]!];
        yield* supersededBy(at, "Check the edge cases", "desktop-second", second);
        yield* at.status("working", second);
        expect(
          yield* tell(at, "And tidy the names", desktop("desktop-first"), first),
        ).toMatchObject({ state: "applied" });
        yield* at.status("working", first);
        yield* at.status("idle", second);

        yield* Effect.sleep(SETTLED);
        expect(revisionOf(yield* waitingOf(at))).toBeUndefined();

        yield* at.status("idle", first);
        const revision = yield* revised(at);
        expect((yield* answer(at, "yes", revision.name)).envelope).toMatchObject({ ok: true });
        yield* until(
          () => shipStarted(at),
          (started) => started,
        );
      }),
    { mode: "pair" },
  ));

test("a message to an agent that did not ask supersedes the question, and any agent the human messaged may answer it", () =>
  atQuestion(
    "collie-supersede-second-answers-",
    (at) =>
      Effect.gen(function* () {
        const [first, second] = [at.agents[0]!, at.agents[1]!];
        yield* supersededBy(at, "Rename the flag", "desktop-first", first);
        yield* at.status("working", first);

        const unmessaged = yield* asAgent(at, second, "go");
        expect(unmessaged.envelope.error?.message).toContain('"go" was superseded');

        expect(
          yield* tell(at, "Looks good, go ahead", desktop("desktop-second"), second),
        ).toMatchObject({ state: "applied" });
        const before = yield* notified(at);
        expect((yield* asAgent(at, second, "go")).envelope).toMatchObject({
          ok: true,
          data: { decision: "go", value: "yes" },
        });
        yield* until(
          () => shipStarted(at),
          (started) => started,
        );

        yield* at.status("idle", first);
        yield* Effect.sleep(SETTLED);
        expect(revisionOf(yield* waitingOf(at))).toBeUndefined();
        expect(
          Arr.filter(yield* notified(at), (line) => !before.includes(line)),
        ).not.toContainEqual(expect.stringContaining("needs-you:ask:"));
      }),
    { mode: "pair" },
  ));

test("a human's message after the question is asked again supersedes the revision too, and the next one moves the Run on", () =>
  atQuestion("collie-supersede-twice-", (at) =>
    Effect.gen(function* () {
      yield* supersededBy(at, "Rework the plan", "desktop-once");
      const second = yield* revised(at);

      expect(yield* tell(at, "Once more, smaller", desktop("desktop-twice"))).toMatchObject({
        state: "applied",
      });
      const set = rowOf(yield* waitingOf(at), second.name);
      expect(set).toMatchObject({ answer: null });
      expect(set?.superseded ?? null).not.toBeNull();

      const third = yield* revised(at, second.name);
      expect(third).toMatchObject({
        prompt: "Ship it?",
        options: [
          { id: "yes", title: "yes" },
          { id: "no", title: "no" },
        ],
        answer: null,
      });
      for (const name of ["go", second.name]) {
        const refused = yield* answer(at, "yes", name);
        expect(refused.envelope.error?.message).toContain(`"${name}" was superseded`);
        expect(refused.envelope.error?.message).toContain(`answer "${third.name}" instead`);
      }
      expect(yield* shipStarted(at)).toBe(false);

      expect((yield* answer(at, "yes", third.name)).envelope).toMatchObject({ ok: true });
      yield* until(
        () => shipStarted(at),
        (started) => started,
      );
    }),
  ));

test("another Run of the same Task keeps its question open and Blocked throughout", () =>
  atQuestion(
    "collie-supersede-other-run-",
    (at) =>
      Effect.gen(function* () {
        const other = yield* waitingRun(at.world, at.client, "start-other", {
          mode: "declared",
          task: "task-shared",
        });
        const stillAsking = Effect.gen(function* () {
          const go = rowOf(yield* waitingOf({ ...at, runId: other.runId }), "go");
          expect(go).toMatchObject({ answer: null });
          expect(go?.superseded ?? null).toBeNull();
          const printed = yield* collie(at.world, ["board"]);
          const { tasks } = yield* Schema.decodeUnknownEffect(Board)(printed.envelope.data).pipe(
            Effect.orDie,
          );
          const card = Arr.findFirst(tasks, (task) => task.runs.includes(other.runId));
          expect(Option.map(card, (task) => task.runs)).toEqual(
            Option.some(expect.arrayContaining([at.runId, other.runId])),
          );
          expect(Option.map(card, (task) => task.state)).toEqual(Option.some("blocked"));
          return Option.getOrThrow(card).questions ?? [];
        });
        const asking = (questions: ReadonlyArray<{ readonly run: string }>, run: string) =>
          Arr.some(questions, (one) => one.run === run);

        expect(asking(yield* stillAsking, other.runId)).toBe(true);
        yield* supersededBy(at, "Rework the plan", "desktop-other-run");
        const aside = yield* stillAsking;
        expect(asking(aside, other.runId)).toBe(true);
        expect(asking(aside, at.runId)).toBe(false);

        const revision = yield* revised(at);
        expect(asking(yield* stillAsking, other.runId)).toBe(true);
        expect((yield* answer(at, "yes", revision.name)).envelope).toMatchObject({ ok: true });
        yield* until(
          () => shipStarted(at),
          (started) => started,
        );
        expect(asking(yield* stillAsking, other.runId)).toBe(true);
      }),
    { mode: "declared", task: "task-shared" },
  ));

test("a human's message to one agent closes that agent's own question, and another agent's stays a Decision", () =>
  atQuestion(
    "collie-supersede-own-question-",
    (at) =>
      Effect.gen(function* () {
        for (const [agent, question] of [
          [at.agents[0]!, "Which database?"],
          [at.agents[1]!, "Which checks?"],
        ] as const) {
          yield* recordClaudeEvent(
            yield* controlDir(at.world.state, agent),
            encode({
              session_id: agent,
              hook_event_name: "PreToolUse",
              tool_name: "AskUserQuestion",
              tool_use_id: `toolu-${agent}`,
              tool_input: { questions: [{ question, header: question, options: PICKS }] },
            }),
            null,
          ).pipe(Effect.orDie);
        }
        yield* until(
          () => waitingOf(at),
          (rows) => rows.length === 3,
        );

        yield* supersededBy(at, "Use SQLite", "desktop-own", at.agents[0]);
        const built = rowOf(yield* waitingOf(at), "ask-build-1");
        expect(built).toMatchObject({ answer: null });
        expect(built?.superseded ?? null).not.toBeNull();
        const checked = rowOf(yield* waitingOf(at), "ask-check-1");
        expect(checked).toMatchObject({ answer: null });
        expect(checked?.superseded ?? null).toBeNull();
        const ids = Arr.map((yield* cardOf(at))?.questions ?? [], (one) => one.id);
        expect(ids).toContain("ask-check-1");
        expect(ids).not.toContain("ask-build-1");
      }),
    { mode: "pair" },
  ));

const typedIn = (at: AtQuestion, prompt: string, agent = at.agent) =>
  Effect.gen(function* () {
    yield* recordClaudeEvent(
      yield* controlDir(at.world.state, agent),
      encode({ session_id: "s-1", hook_event_name: "UserPromptSubmit", prompt }),
      null,
    ).pipe(Effect.orDie);
  });

const setAside = (at: AtQuestion, name: string) =>
  until(
    () => waitingOf(at),
    (rows) => (rowOf(rows, name)?.superseded ?? null) !== null,
  ).pipe(Effect.map((rows) => rowOf(rows, name)!));

test("typing into the agent's Claude pane sets the question aside while it works, and the question is asked again after", () =>
  atQuestion("collie-supersede-typed-", (at) =>
    Effect.gen(function* () {
      yield* at.status("working");
      yield* typedIn(at, "Call it the chooser");
      const go = yield* setAside(at, "go");
      expect(go).toMatchObject({ answer: null });
      expect(go.cause).toMatch(new RegExp(`^${at.agent}:submit:\\d+$`));

      const card = yield* cardOf(at);
      expect(card?.state).toBe("active");
      expect(card?.decision).toBeNull();
      expect(card?.sentence).toContain(`Working on what you told ${at.agent}`);

      yield* at.status("idle");
      expect(yield* revised(at)).toMatchObject({ prompt: "Ship it?", answer: null });
    }),
  ));

test("a submit that carries Collie's delivery or the harness's own leaves the question open", () =>
  atQuestion("collie-supersede-not-typed-", (at) =>
    Effect.gen(function* () {
      yield* typedIn(at, "collie-delivery:r-1-build-step-2\nYour task for this step is next.");
      yield* typedIn(at, "<task-notification>a background task finished</task-notification>");
      yield* typedIn(at, '<agent-message from="planner">Carry on</agent-message>');
      yield* Effect.sleep(SETTLED);
      const go = rowOf(yield* waitingOf(at), "go");
      expect(go).toMatchObject({ answer: null });
      expect(go?.superseded ?? null).toBeNull();
      expect((yield* cardOf(at))?.decision).not.toBeNull();

      yield* typedIn(at, "Now something else");
      yield* setAside(at, "go");
    }),
  ));

test("typing into the agent's Claude pane closes its own question, which is not asked again", () =>
  atQuestion("collie-supersede-typed-own-", (at) =>
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        yield* controlDir(at.world.state, at.agent),
        encode({
          session_id: "s-1",
          hook_event_name: "PreToolUse",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu-own",
          tool_input: {
            questions: [{ question: "Which database?", header: "Database", options: PICKS }],
          },
        }),
        null,
      ).pipe(Effect.orDie);
      yield* until(
        () => waitingOf(at),
        (rows) => rows.length === 2,
      );

      yield* typedIn(at, "Use SQLite");
      expect(yield* setAside(at, "ask-build-1")).toMatchObject({ answer: null });
      yield* revised(at);
      yield* Effect.sleep(SETTLED);
      expect(revisionOf(yield* waitingOf(at), "ask-build-1")).toBeUndefined();
    }),
  ));

test("a workflow Choice's steering entry names the agent `run steer` reaches, and blank words are refused and supersede nothing", () =>
  atQuestion("collie-steer-entry-", (at) =>
    Effect.gen(function* () {
      // WARNING: herdr's live agents are read only at the board's next tick, so wait for it.
      const card = yield* until(
        () => cardOf(at),
        (one) => one?.questions?.[0]?.steer?.agent != null,
      );
      expect(Arr.map(card?.questions ?? [], (one) => one.steer)).toEqual([
        { agent: at.agent, why: null },
      ]);

      const blank = yield* tell(at, " \n\t ", desktop("blank-1"));
      expect(blank?.state).not.toBe("applied");
      expect(blank?.note).toContain("nothing to send");
      expect(rowOf(yield* waitingOf(at), "go")).toMatchObject({ answer: null, superseded: null });
    }),
  ));
