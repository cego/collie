// A human's message to a Run's agent supersedes the Workflow's open question, and the
// question is asked again once that work ends, if it still holds the Run
// (ADR-draft-a-humans-message-supersedes-a-runs-open-question D1, D3, D6–D8). The host is a
// real one over a fake herdr, running `stepped`: an agent, a question, then an agent.

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Config, Effect, FileSystem, Option, Schema, type Scope, flow, Result } from "effect";
import { act, bridgeCommand, openBridge } from "../desktop/src/bun/machine";
import { readEnv, type PluginEnv } from "../src/env";
import { resetExecutors } from "../src/executors";
import { connect } from "../src/host";
import { carryOutAsked } from "../src/run-actions";
import { SENT_STATES, deliveriesOf } from "../src/steering";
import { TaskView } from "../src/board-model";
import {
  proposalsPath,
  read as readProposals,
  record as recordProposal,
  type Actor,
} from "../src/proposals";
import { agentName } from "../src/naming";
import { epochMs } from "../src/time";
import { suiteEnv } from "./support/effect";
import { root, stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const FakeState = Schema.fromJsonString(
  Schema.Struct({ agents: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);
const Board = Schema.Struct({ tasks: Schema.Array(TaskView) });

const GRACE_MS = 3_000;
/** Past the grace and two of the host's board ticks: long enough for a revision to have opened. */
const SETTLED = "14 seconds";

type Client = Effect.Success<ReturnType<typeof connect>>;

interface AtQuestion {
  readonly world: World;
  readonly env: PluginEnv;
  readonly client: Client;
  readonly runId: string;
  readonly agent: string;
  /** Every agent the Run started before its question, oldest first. */
  readonly agents: ReadonlyArray<string>;
  /** Sets what the fake herdr says of `agent`, or of every agent: `working` or `idle`. */
  readonly status: (status: string, agent?: string) => Effect.Effect<void>;
}

interface Setup {
  /** `pair` has two agents work before the question. */
  readonly mode: "declared" | "pair";
  readonly task?: string;
}

/** The Run's host, started from this process with this world's fake herdr and grace period. */
const startHost = (world: World) => connect(world.state).pipe(Effect.orDie);

/** A `stepped` Run started under `request`, once it waits on `go`, and its idle agents. */
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
  yield* until(
    () => client.run({ runId }).pipe(Effect.orDie),
    (view) =>
      view?.status.status === "suspended" &&
      Arr.some(view.waiting, (one) => one.name === "go" && one.answer === null),
  );
  const fs = yield* FileSystem.FileSystem;
  const herdr = yield* Schema.decodeEffect(FakeState)(
    yield* fs.readFileString(`${Bun.env.FAKE_HERDR_LOG}.state.json`).pipe(Effect.orDie),
  ).pipe(Effect.orDie);
  const agents = Arr.map(setup.mode === "pair" ? ["build", "check"] : ["build"], (step) =>
    agentName(runId, step, null, 1),
  );
  expect(Arr.map(herdr.agents, (one) => one.name)).toEqual(expect.arrayContaining(agents));
  return { runId, agent: agents.at(-1)!, agents };
});

/** A `stepped` Run waiting on `go` after its first agent's step, and its idle agent. */
const atQuestion = <A, E>(
  prefix: string,
  body: (at: AtQuestion) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  setup: Setup = { mode: "declared" },
) =>
  proves(
    prefix,
    (world) =>
      Effect.gen(function* () {
        resetExecutors();
        const fs = yield* FileSystem.FileSystem;
        const outputs = `${world.home}/outputs.json`;
        const file = `${world.home}/agent-status`;
        yield* fs
          .writeFileString(outputs, encode(Arr.makeBy(6, () => ({ verdict: "done" }))))
          .pipe(Effect.orDie);
        const status = (said: string, agent?: string) =>
          fs
            .writeFileString(agent === undefined ? file : `${file}.${agent}`, said)
            .pipe(Effect.orDie);
        yield* status("idle");
        const set = {
          FAKE_HERDR_OUTPUTS: outputs,
          FAKE_HERDR_AGENT_STATUS_FILE: file,
          HERDR_PLUGIN_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          COLLIE_HOST_SUPERSEDE_GRACE_MS: String(GRACE_MS),
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
        const env = readEnv({
          HERDR_PLUGIN_ROOT: world.install,
          HERDR_PLUGIN_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          HOME: world.home,
          COLLIE_CWD: world.project,
        });
        const client = yield* startHost(world);
        const { runId, agent, agents } = yield* waitingRun(world, client, "start", setup);
        return yield* body({ world, env, client, runId, agent, agents, status }).pipe(
          Effect.ensuring(stopHost(world.state)),
        );
      }),
    ["stepped.workflow.ts"],
  );

const desktop = (requestId: string): Actor => ({ origin: "desktop", requestId });

/** One message to one of the Run's agents, from whoever `by` is. */
const tell = (at: AtQuestion, text: string, by: Actor, agent = at.agent) =>
  Effect.map(
    carryOutAsked(at.env, [{ kind: "deliver", run: at.runId, agent, text, mode: "boundary" }], by),
    ([done]) => done,
  );

const waitingOf = (at: AtQuestion, client: Client = at.client) =>
  client.run({ runId: at.runId }).pipe(
    Effect.orDie,
    Effect.map((view) => view?.waiting ?? []),
  );

const rowOf = (waiting: Effect.Success<ReturnType<typeof waitingOf>>, name: string) =>
  Option.getOrUndefined(Arr.findFirst(waiting, (one) => one.name === name));

/** The question asked again in `of`'s place, once one is open. */
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
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs
      .readFileString(`${at.world.state}/notified.${at.runId}`)
      .pipe(Effect.orElseSucceed(() => "")),
  ).pipe(Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")));

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
  });

test(
  "a human's Desktop message sets the question aside while its agent works, and the question is asked again after",
  () =>
    atQuestion("collie-supersede-replay-", (at) =>
      Effect.gen(function* () {
        const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
        const command = Option.isSome(binary)
          ? [binary.value]
          : [process.execPath, `${root}src/main.ts`];
        const bridge = yield* openBridge(bridgeCommand(command, "mk-pc"), {
          PATH: "/usr/bin:/bin",
          HOME: at.world.home,
          HERDR_PLUGIN_ROOT: at.world.install,
          HERDR_PLUGIN_STATE_DIR: at.world.state,
          COLLIE_USER_DIR: at.world.config,
          COLLIE_HOST: encode(command),
          ...(yield* suiteEnv),
          HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH ?? "",
          FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG ?? "",
        });
        const reached = { machine: { profile: "local", name: "mk-pc" }, desktop: bridge };
        yield* act(reached, "desktop-message-1", {
          _tag: "Deliver",
          runId: at.runId,
          agent: at.agent,
          text: "Call it the chooser",
        }).pipe(Effect.orDie);
        yield* until(
          () => deliveriesOf(at.world.state, at.runId),
          (lines) =>
            Arr.some(
              lines,
              (one) => one.delivery.cause.kind === "steer" && SENT_STATES.has(one.delivery.state),
            ),
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
          options: ["yes", "no"],
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
    ),
  180_000,
);

test(
  "the agent the human messaged may still answer the question itself, and nobody else may",
  () =>
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
        // As `plan.md` tells a planner: the human said go, so it answers the menu itself.
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
        expect(
          Arr.filter(yield* notified(at), (line) => !before.includes(line)),
        ).not.toContainEqual(expect.stringContaining("needs-you:ask:"));
      }),
    ),
  180_000,
);

test(
  "a message that is one of the options answers nothing, and the question is asked again only after the grace period",
  () =>
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
    ),
  180_000,
);

test(
  "a message that is not a human's supersedes nothing",
  () =>
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
          yield* deliveriesOf(at.world.state, at.runId),
          (one) => one.delivery.cause.kind === "steer" && SENT_STATES.has(one.delivery.state),
        );
        expect(steered).toHaveLength(2);

        const go = rowOf(yield* waitingOf(at), "go");
        expect(go).toMatchObject({ answer: null });
        expect(go?.superseded ?? null).toBeNull();
        const card = yield* cardOf(at);
        expect(card?.state).toBe("blocked");
        expect(card?.decision).not.toBeNull();
      }),
    ),
  180_000,
);

test(
  "a host started again after the work ended asks the question again, and its answer moves the Run on",
  () =>
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
    ),
  180_000,
);

test(
  "a Hold still holds the work a revision's answer starts, and Proposals are untouched",
  () =>
    atQuestion("collie-supersede-held-", (at) =>
      Effect.gen(function* () {
        const proposals = yield* proposalsPath(at.world.state, "some-herd");
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
    ),
  180_000,
);

test(
  "a Run stopped while its agent works on the message does not ask the question again, before or after a restart",
  () =>
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
    ),
  180_000,
);

/** The revision opened in `of`'s place, once the host has opened one. */
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

test(
  "a question set aside is asked again only once every agent the human messaged has finished",
  () =>
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
    ),
  180_000,
);

test(
  "a message to an agent that did not ask supersedes the question, and any agent the human messaged may answer it",
  () =>
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
    ),
  180_000,
);

test(
  "a human's message after the question is asked again supersedes the revision too, and the next one moves the Run on",
  () =>
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
        expect(third).toMatchObject({ prompt: "Ship it?", options: ["yes", "no"], answer: null });
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
    ),
  180_000,
);

test(
  "another Run of the same Task keeps its question open and Blocked throughout",
  () =>
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
    ),
  180_000,
);
