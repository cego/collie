// A finished Run's live agents still take steering (ADR-0041), through the host an
// installation runs: the Dispatcher, the ledger and the receipt a running Run gets, and a
// status nothing rewrites.

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Config, Effect, FileSystem, Option, Schema, type Scope, flow, Result } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { act, bridgeCommand, openBridge } from "../desktop/src/bun/machine";
import { readEnv } from "../src/env";
import { resetExecutors } from "../src/executors";
import { connect } from "../src/host";
import { isSettled } from "../src/lifecycle";
import { carryOutAsked } from "../src/run-actions";
import { DELIVERY_TOKEN } from "../src/dispatcher";
import { runDir } from "../src/engine";
import { readAudit } from "../src/audit";
import { attachFiles, type FlowPrompts } from "../src/flows";
import { appendLine, deliveriesOf, ledgerPath, readLedger } from "../src/steering";
import { capabilitiesOf } from "../src/steering-caps";
import { Herdr } from "../src/herdr";
import { suiteEnv } from "./support/effect";
import { root, stopHost, until } from "./support/host";
import { hosted, hostedRun } from "./support/hosted";
import { collie, proves, type World } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const FakeState = Schema.fromJsonString(
  Schema.Struct({
    agents: Schema.Array(Schema.Struct({ name: Schema.String, pane_id: Schema.String })),
  }),
);
const CallLine = Schema.fromJsonString(
  Schema.Struct({ cmd: Schema.String, argv: Schema.Array(Schema.String) }),
);

/** A `told` Run that has succeeded with its agent still alive, and the env chat acts in. */
const finishedWithAgent = Effect.fn("test.finishedWithAgent")(function* (
  world: World,
  workflow = "told",
  status = "complete",
) {
  resetExecutors();
  const env = readEnv({
    HERDR_PLUGIN_ROOT: world.install,
    HERDR_PLUGIN_STATE_DIR: world.state,
    COLLIE_USER_DIR: world.config,
    HOME: world.home,
    COLLIE_CWD: world.project,
  });
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  const started = yield* client
    .start({ project: world.project, id: workflow, request, input: { work: "the picker" } })
    .pipe(Effect.orDie);
  const view = yield* until(
    () => client.run({ runId: started.runId }).pipe(Effect.orDie),
    (one) =>
      one !== null && (status === "suspended" ? one.status.status === status : isSettled(one)),
  );
  expect(view?.status).toMatchObject({ status });
  const fs = yield* FileSystem.FileSystem;
  const herdr = yield* Schema.decodeEffect(FakeState)(
    yield* fs.readFileString(`${Bun.env.FAKE_HERDR_LOG}.state.json`).pipe(Effect.orDie),
  ).pipe(Effect.orDie);
  const agent = herdr.agents[0]!;
  return { env, client, runId: started.runId, agent };
});

const deliver = (runId: string, agent: string, text: string) => ({
  kind: "deliver" as const,
  run: runId,
  agent,
  text,
  mode: "boundary" as const,
});

let asked = 0;

test(
  "the host accepts a queued comment with a truthful receipt and later submits it",
  () =>
    steerable(
      "collie-queued-comments-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const status = `${world.home}/status`;
          yield* fs.writeFileString(status, "idle").pipe(Effect.orDie);
          yield* fs
            .writeFileString(
              `${world.config}/config.json`,
              encode({ harness: "codex", model: "default", compact_at_tokens: 0, trust: "never" }),
            )
            .pipe(Effect.orDie);
          const before = Bun.env.FAKE_HERDR_AGENT_STATUS_FILE;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              Bun.env.FAKE_HERDR_AGENT_STATUS_FILE = status;
            }),
            () =>
              Effect.sync(() => {
                if (before === undefined) delete Bun.env.FAKE_HERDR_AGENT_STATUS_FILE;
                else Bun.env.FAKE_HERDR_AGENT_STATUS_FILE = before;
              }),
          );
          const { env, client, runId, agent } = yield* finishedWithAgent(
            world,
            "commented-plan",
            "suspended",
          );
          yield* fs.writeFileString(status, "working").pipe(Effect.orDie);
          const text = "Preserve this exact comment.\n  Include the attachment.  ";
          const attachment = `${world.home}/comment.txt`;
          yield* fs.writeFileString(attachment, "evidence").pipe(Effect.orDie);
          const request = { origin: "desktop" as const, requestId: "queue-desktop" };
          const action = {
            ...deliver(runId, agent.name, text),
            mode: "now" as const,
            attachments: [attachment],
          };
          const [done] = yield* carryOutAsked(env, [action], request);
          expect(done).toMatchObject({ state: "applied" });
          expect(done?.note).toContain("Queued durably");
          const records = Arr.filter(
            yield* readAudit(runDir(world.state, runId)),
            (line) => line.operation === "deliver",
          );
          expect(records.at(-1)?.result).toMatchObject({ delivered: false, queued: true });
          yield* carryOutAsked(env, [action], request);
          yield* fs.writeFileString(status, "idle").pipe(Effect.orDie);
          const deliveries = yield* until(
            () => client.deliveries({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.some(
                lines ?? [],
                (one) => one.cause.kind === "steer" && one.state === "acknowledged",
              ),
          );
          expect(Arr.filter(deliveries ?? [], (one) => one.cause.kind === "steer")).toHaveLength(1);
          const calls = yield* Effect.forEach(
            Arr.filter(
              Str.split(yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orDie), "\n"),
              Boolean,
            ),
            (line) => Schema.decodeEffect(CallLine)(line).pipe(Effect.orDie),
          );
          const said =
            Arr.filter(
              calls,
              (call) => call.cmd === "agent prompt" && call.argv[2] === agent.name,
            ).at(-1)?.argv[3] ?? "";
          expect(said).toContain("From the human, in Desktop");
          const kept = /Their message is in (\S+)\./.exec(said)?.[1];
          const words =
            kept === undefined ? said : yield* fs.readFileString(kept).pipe(Effect.orDie);
          expect(words).toContain(text);
          expect(words).toContain("Attached:");
          expect(words).toContain("comment.txt");
          const view = yield* client.run({ runId }).pipe(Effect.orDie);
          expect(
            Option.getOrUndefined(
              Arr.findFirst(view?.waiting ?? [], (one) => one.name === "next-choice"),
            ),
          ).toMatchObject({
            answer: null,
          });
          expect(view?.status.status).toBe("suspended");
        }),
      [{ verdict: "built" }],
      ["commented-plan.workflow.ts"],
    ),
  120_000,
);
/** Chat, under a request id of each call's own: one id twice is one operation. */
const chat = () => ({ origin: "chat" as const, requestId: `req-chat-${++asked}` });

/** A world whose fake agent answers its one prompt with an Output, and is then left alive. */
const steerable = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  /** What the fake agent answers its prompts with; none leaves it working for good. */
  answers: ReadonlyArray<{ readonly verdict: string }> = [{ verdict: "built" }],
  modules: ReadonlyArray<string> = ["told.workflow.ts"],
) =>
  proves(
    prefix,
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outputs = `${world.home}/outputs.json`;
        yield* fs.writeFileString(outputs, encode(answers)).pipe(Effect.orDie);
        // The host a client spawns inherits this process's environment: it has to own this
        // world's state, never the operator's.
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
        return yield* body(world).pipe(Effect.ensuring(stopHost(world.state)));
      }),
    modules,
  );

test(
  "a chat that clears an override is recorded with the human's words",
  () =>
    steerable("collie-finished-override-", (world) =>
      Effect.gen(function* () {
        const finished = yield* finishedWithAgent(world);
        const { runId, agent } = finished;
        // Cleared here rather than by the host, so it has to reach this world's herdr.
        const env = { ...finished.env, binPath: Bun.env.HERDR_BIN_PATH! };
        const live = yield* new Herdr(env).agentList().pipe(Effect.orDie);
        const terminal = Option.getOrUndefined(
          Arr.findFirst(live, (one) => one.name === agent.name),
        )!.terminalId!;
        const ledger = yield* ledgerPath(world.state, terminal);
        yield* appendLine(ledger, {
          kind: "manual_override",
          at: "2026-10-05T10:00:00.000Z",
          incarnation: terminal,
          by: "hook:UserPromptSubmit",
        });
        const voiced = { ...chat(), conversation: "native", said: "let Collie steer it again" };
        const [done] = yield* carryOutAsked(
          env,
          [{ kind: "clear_override", run: runId, agent: agent.name }],
          voiced,
        );
        expect(done).toMatchObject({ kind: "clear_override", state: "applied" });
        expect((yield* readLedger(ledger)).at(-1)).toMatchObject({
          kind: "override_cleared",
          conversation: "native",
          said: "let Collie steer it again",
        });
      }),
    ),
  120_000,
);

test(
  "a succeeded Run's live agent takes a delivery, with its token and a ledger receipt",
  () =>
    steerable("collie-finished-deliver-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);

        const [done] = yield* carryOutAsked(env, [deliver(runId, agent.name, "merge it")], chat());
        expect(done).toMatchObject({ kind: "deliver", state: "applied" });

        const steered = Arr.filter(
          yield* deliveriesOf(world.state, runId),
          (one) => one.delivery.cause.kind === "steer",
        );
        expect(steered).toHaveLength(1);
        const fs = yield* FileSystem.FileSystem;
        const prompts = Arr.filter(
          Arr.map(
            Arr.filter(
              Str.split(yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orDie), "\n"),
              (line) => line !== "",
            ),
            (line) => flow(Schema.decodeResult(CallLine), Result.getOrThrow)(line),
          ),
          (call) => call.cmd === "agent prompt" && call.argv[2] === agent.name,
        );
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(prompts.at(-1)), (present) =>
              Arr.join(present.argv, " "),
            ),
          ),
        ).toContain(`${DELIVERY_TOKEN}${steered[0]!.delivery.id}`);
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(prompts.at(-1)), (present_) =>
              Arr.join(present_.argv, " "),
            ),
          ),
        ).toContain("merge it");
      }),
    ),
  120_000,
);

test(
  "a steer is typed plain within 3 lines and 700 characters, or kept as a file the typed line names",
  () =>
    steerable("collie-finished-budget-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);
        const fs = yield* FileSystem.FileSystem;
        const typed = Effect.map(
          fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orDie),
          (log) =>
            Arr.filter(
              Arr.map(
                Arr.filter(Str.split(log, "\n"), (line) => line !== ""),
                (line) => flow(Schema.decodeResult(CallLine), Result.getOrThrow)(line),
              ),
              (call) => call.cmd === "agent prompt" && call.argv[2] === agent.name,
            ).at(-1)?.argv[3] ?? "",
        );
        const steer = (
          text: string,
          actor: Parameters<typeof carryOutAsked>[2],
          attachments?: ReadonlyArray<string>,
        ) =>
          Effect.gen(function* () {
            const action: ReturnType<typeof deliver> & { attachments?: ReadonlyArray<string> } =
              deliver(runId, agent.name, text);
            if (attachments !== undefined) action.attachments = attachments;
            const [done] = yield* carryOutAsked(env, [action], actor);
            expect(done).toMatchObject({ kind: "deliver", state: "applied" });
            const lines = Str.split(yield* typed, "\n");
            expect(lines[0]).toStartWith(`${DELIVERY_TOKEN}${runId}-${actor.requestId}`);
            expect(lines.length).toBeLessThanOrEqual(3);
            expect(Array.from(Arr.join(lines, "\n")).length).toBeLessThanOrEqual(700);
            const file =
              /^Their message is in (\S+)\. Read it whole and act on it as theirs\.$/.exec(
                lines[2] ?? "",
              )?.[1];
            const kept =
              file === undefined ? null : yield* fs.readFileString(file).pipe(Effect.orDie);
            return { lines, kept, note: done?.note ?? "" };
          });
        const board = (n: number) => ({ origin: "board" as const, requestId: `board-${n}` });
        const AUTO_MODE =
          "Kept as a file in the Run. Auto mode reads only what is typed: ask for an action it must clear in a message of at most 3 lines and 700 characters.";

        const plain = yield* steer("merge it", board(1));
        expect(plain.lines).toHaveLength(3);
        expect(plain.lines[1]).toMatch(/^From the human, on the board, .+\.$/);
        expect(plain.lines[2]).toBe("merge it");
        expect(plain.note).not.toContain("Kept as a file");

        const twoLines = yield* steer("merge it\nthen tag it", board(2));
        expect(twoLines.kept).toBe("merge it\nthen tag it");
        expect(twoLines.lines[1]).toMatch(/^From the human, on the board, .+\.$/);
        expect(twoLines.note).toContain(AUTO_MODE);

        const room = 700 - plain.lines[0]!.length - plain.lines[1]!.length - 2;
        const fills = yield* steer(Str.repeat(room)("y"), board(3));
        expect(fills.kept).toBeNull();
        const over = yield* steer(Str.repeat(room + 1)("z"), board(4));
        expect(over.kept).toBe(Str.repeat(room + 1)("z"));

        const shot = `${world.project}/shot.png`;
        yield* fs.writeFileString(shot, "png").pipe(Effect.orDie);
        const attached = yield* steer("look at this", board(5), [shot]);
        expect(attached.kept).toMatch(/^look at this\nAttached: \S+shot\.png$/);

        const longSaid = pipe_("s", Str.repeat(900));
        for (const [n, said] of [longSaid, "first line\nsecond line"].entries()) {
          const chatted = yield* steer("merge it", {
            origin: "chat",
            requestId: `chat-said-${n}`,
            conversation: "c-1",
            said,
          });
          expect(chatted.kept).toBe(`The human said: "${said}"\n\nmerge it`);
          expect(chatted.lines[1]).toMatch(/^From chat for the human, [^"]+\.$/);
        }

        const desktop = yield* steer("merge it", { origin: "desktop", requestId: "desktop-1" });
        expect(desktop.lines[1]).toMatch(/^From the human, in Desktop, .+\.$/);
        const desktopLong = yield* steer(`${pipe_("é", Str.repeat(5_000))}\n  kept as typed  `, {
          origin: "desktop",
          requestId: "desktop-2",
        });
        expect(desktopLong.kept).toBe(`${pipe_("é", Str.repeat(5_000))}\n  kept as typed  `);
        expect(desktopLong.lines[1]).toMatch(/^From the human, in Desktop, .+\.$/);
      }),
    ),
  120_000,
);

test(
  "review comments Desktop sends reach the chosen live agent, signed as the human in Desktop, once per request",
  () =>
    steerable("collie-finished-comments-", (world) =>
      Effect.gen(function* () {
        // Desktop delivers `now`, which the host sends only to a claude it knows is new enough.
        const fs = yield* FileSystem.FileSystem;
        const bin = `${world.home}/bin`;
        yield* fs.makeDirectory(bin, { recursive: true }).pipe(Effect.orDie);
        const floor = capabilitiesOf("claude")!.now.version_floor;
        yield* fs
          .writeFileString(
            `${bin}/claude`,
            `#!/bin/sh\n[ "$1" = --version ] && echo ${floor} && exit 0\n[ "$1" = --help ] && echo "  --autocompact <auto|tokens>" && exit 0\nexit 1\n`,
            { mode: 0o755 },
          )
          .pipe(Effect.orDie);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const before = Bun.env.PATH;
            Bun.env.PATH = `${bin}:${before ?? ""}`;
            return before;
          }),
          (before) => Effect.sync(() => void (Bun.env.PATH = before)),
        );
        const { runId, agent } = yield* finishedWithAgent(world);
        const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
        const command = Option.isSome(binary)
          ? [binary.value]
          : [process.execPath, `${root}src/main.ts`];
        const desktop = yield* openBridge(bridgeCommand(command, "mk-pc"), {
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
        const comments =
          "1 review comment from the human in Desktop.\n\n1. the plan's `SPEC.md`\n> the picker\n\nCall it the chooser";
        const reached = { machine: { profile: "local", name: "mk-pc" }, desktop };
        const comment = { _tag: "Deliver", runId, agent: agent.name, text: comments } as const;
        yield* act(reached, "desktop-comments-1", comment).pipe(Effect.orDie);
        yield* act(reached, "desktop-comments-1", comment).pipe(Effect.orDie);

        const steered = Arr.filter(
          yield* deliveriesOf(world.state, runId),
          (one) => one.delivery.cause.kind === "steer",
        );
        expect(steered).toHaveLength(1);
        const typed = Arr.filter(
          Arr.map(
            Arr.filter(
              Str.split(yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orDie), "\n"),
              (line) => line !== "",
            ),
            (line) => flow(Schema.decodeResult(CallLine), Result.getOrThrow)(line),
          ),
          (call) => call.cmd === "agent prompt" && call.argv[2] === agent.name,
        ).at(-1)?.argv[3];
        const lines = Str.split(typed ?? "", "\n");
        expect(lines[0]).toStartWith(`${DELIVERY_TOKEN}${steered[0]!.delivery.id}`);
        expect(lines[1]).toMatch(/^From the human, in Desktop, .+\.$/);
        const file = /^Their message is in (\S+)\./.exec(lines[2] ?? "")?.[1];
        expect(yield* fs.readFileString(file!).pipe(Effect.orDie)).toBe(comments);
      }),
    ),
  120_000,
);

test(
  "a finished Run whose agent is gone fails the delivery and names its follow-up offer",
  () =>
    steerable("collie-finished-gone-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);
        yield* Effect.promise(() =>
          Bun.$`${Bun.env.HERDR_BIN_PATH!} pane close ${agent.pane_id}`.quiet(),
        );

        const [done] = yield* carryOutAsked(env, [deliver(runId, agent.name, "tag it")], chat());
        expect(done?.state).toBe("failed");
        expect(done?.note).toContain('follow-up offer "carry-on"');
        expect(done?.note).toContain("giving the message as its input");
      }),
    ),
  120_000,
);

test(
  "a finished Run's agent the idle close ended refuses a steer and names the follow-up offer",
  () =>
    steerable("collie-finished-idle-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .writeFileString(`${world.config}/config.json`, encode({ idle_close_ms: 1 }))
          .pipe(Effect.orDie);
        const { env, client, runId, agent } = yield* finishedWithAgent(world);

        const swept = yield* until(
          () => client.sweep({ request: `sweep-${++asked}` }).pipe(Effect.orDie),
          (report) => Arr.some(report.remove, (item) => item.kind === "idle-agent"),
        );
        expect(
          Option.getOrUndefined(
            Option.flatMap(Option.fromNullishOr(swept), (present__) =>
              Option.map(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst(present__.remove, (item) => item.kind === "idle-agent"),
                  ),
                ),
                (present___) => present___.target,
              ),
            ),
          ),
        ).toBe(`${agent.name} of ${runId}`);

        const [done] = yield* carryOutAsked(env, [deliver(runId, agent.name, "tag it")], chat());
        expect(done?.state).toBe("failed");
        expect(done?.note).toContain('follow-up offer "carry-on"');
      }),
    ),
  120_000,
);

test(
  "a stop closes a succeeded Run's live pane and leaves it succeeded",
  () =>
    steerable("collie-finished-stop-", (world) =>
      Effect.gen(function* () {
        const { env, client, runId, agent } = yield* finishedWithAgent(world);

        const [done] = yield* carryOutAsked(env, [{ kind: "stop", run: runId }], chat());
        expect(done).toMatchObject({ kind: "stop", state: "applied" });
        expect(done?.note).toContain(`Closed ${agent.name}`);
        const fs = yield* FileSystem.FileSystem;
        const herdr = yield* Schema.decodeEffect(FakeState)(
          yield* fs.readFileString(`${Bun.env.FAKE_HERDR_LOG}.state.json`).pipe(Effect.orDie),
        ).pipe(Effect.orDie);
        expect(Arr.map(herdr.agents, (one) => one.name)).not.toContain(agent.name);

        const view = yield* client.run({ runId }).pipe(Effect.orDie);
        expect(view?.status.status).toBe("complete");
        expect(view?.controls).toEqual([]);

        const again = yield* carryOutAsked(env, [{ kind: "stop", run: runId }], chat());
        expect(again[0]?.note).toBe(`Nothing of ${runId} was running.`);
      }),
    ),
  120_000,
);

test(
  "a succeeded Run's agent is still told after its module was removed",
  () =>
    steerable("collie-finished-unregistered-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${world.user}/told.workflow.ts`).pipe(Effect.orDie);
        // A host started again finds no module to register the Run's generation under.
        yield* stopHost(world.state);

        const [done] = yield* carryOutAsked(env, [deliver(runId, agent.name, "merge it")], chat());
        expect(done).toMatchObject({ kind: "deliver", state: "applied" });
      }),
    ),
  120_000,
);

test(
  "a steer that reached nobody on a running Run is failed, never applied",
  () =>
    hosted("collie-running-undelivered-", ({ world, env }) =>
      Effect.gen(function* () {
        const run = yield* hostedRun(world, "add a picker");
        const [done] = yield* carryOutAsked(env, [deliver(run.id, "nobody", "hurry up")], chat());
        expect(done?.state).toBe("failed");
        expect(done?.note).toContain("Nothing was delivered");
      }),
    ),
  120_000,
);

test(
  "with its module removed, a succeeded Run's stop sets nothing and its gone agent's request is routed on",
  () =>
    steerable("collie-finished-unregistered-stop-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);
        const fs = yield* FileSystem.FileSystem;
        const module = `${world.user}/told.workflow.ts`;
        const saved = yield* fs.readFileString(module).pipe(Effect.orDie);
        yield* fs.remove(module).pipe(Effect.orDie);
        yield* stopHost(world.state);

        const [stopped] = yield* carryOutAsked(env, [{ kind: "stop", run: runId }], chat());
        expect(stopped).toMatchObject({ kind: "stop", state: "applied" });
        expect(stopped?.note).toContain(`Closed ${agent.name}`);

        const [told] = yield* carryOutAsked(env, [deliver(runId, agent.name, "tag it")], chat());
        expect(told?.state).toBe("failed");
        expect(told?.note).toContain("has finished and its agent is gone");

        // Back with its module: still the status it finished with, under no control.
        yield* fs.writeFileString(module, saved).pipe(Effect.orDie);
        yield* stopHost(world.state);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const view = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (one) => one !== null && one.diagnostic === null,
        );
        expect(view?.status.status).toBe("complete");
        expect(view?.controls).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "the CLI's hold and release on a finished Run are refused as chat's are",
  () =>
    steerable("collie-finished-hold-", (world) =>
      Effect.gen(function* () {
        const { runId } = yield* finishedWithAgent(world);
        for (const verb of ["hold", "release"]) {
          const said = yield* collie(world, ["run", verb, runId]);
          expect(said.envelope.ok).toBe(false);
          expect(said.envelope.error?.message).toContain(
            "a finished Run has no step left to hold; stop closes its agents",
          );
        }
      }),
    ),
  120_000,
);

test(
  "a stopped Run's closed agent is not told, and the request is routed on",
  () =>
    steerable(
      "collie-stopped-gone-",
      (world) =>
        Effect.gen(function* () {
          resetExecutors();
          const env = readEnv({
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            HOME: world.home,
            COLLIE_CWD: world.project,
          });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
          const { runId } = yield* client
            .start({ project: world.project, id: "told", request, input: { work: "the picker" } })
            .pipe(Effect.orDie);
          const fs = yield* FileSystem.FileSystem;
          // Its one agent is up and working, and nothing will ever come of it.
          const herdr = yield* until(
            () =>
              fs.readFileString(`${Bun.env.FAKE_HERDR_LOG}.state.json`).pipe(
                Effect.map((text) => flow(Schema.decodeResult(FakeState), Result.getOrThrow)(text)),
                Effect.orElseSucceed(() => ({ agents: [] })),
              ),
            (state) => state.agents.length > 0,
          );
          const agent = herdr.agents[0]!;

          const [stopped] = yield* carryOutAsked(env, [{ kind: "stop", run: runId }], chat());
          expect(stopped?.state).toBe("applied");

          const [told] = yield* carryOutAsked(env, [deliver(runId, agent.name, "tag it")], chat());
          expect(told?.state).toBe("failed");
          expect(told?.note).toContain("has finished and its agent is gone");

          const held = yield* collie(world, ["run", "hold", runId]);
          expect(held.envelope.error?.message).toContain("a finished Run has no step left to hold");
        }),
      [],
    ),
  120_000,
);

/** The board's prompts, answering the one question with `typed`. */
const typing = (typed: string): FlowPrompts => ({
  menu: () => Effect.succeed(null),
  ask: () => Effect.succeed(typed),
});

test(
  "the board's Attach files… hands the typed files to the Run's live agent",
  () =>
    steerable("collie-attach-board-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { env, runId } = yield* finishedWithAgent(world);
        yield* fs.writeFileString(`${world.project}/my shot.png`, "png").pipe(Effect.orDie);
        yield* fs.writeFileString(`${world.project}/log.txt`, "log").pipe(Effect.orDie);

        const note = yield* attachFiles(
          { ...env, cwd: world.project },
          typing(`'my shot.png' ${world.project}/log.txt`),
          runId,
        );
        expect(note).toStartWith("Delivered to ");
        const dir = `${runDir(world.state, runId)}/attachments`;
        expect(yield* fs.readFileString(`${dir}/my shot.png`).pipe(Effect.orDie)).toBe("png");
        const told = Option.getOrUndefined(
          Arr.findLast(
            Arr.map(
              Arr.filter(
                Arr.map(
                  Arr.filter(
                    Str.split(
                      yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orDie),
                      "\n",
                    ),
                    (line) => line !== "",
                  ),
                  (line) => flow(Schema.decodeResult(CallLine), Result.getOrThrow)(line),
                ),
                (call) => call.cmd === "agent prompt",
              ),
              (call) => Arr.join(call.argv, " "),
            ),
            (text) => pipe_(text, Str.includes("Their message is in")),
          ),
        );
        const kept = /Their message is in (\S+)\./.exec(told ?? "")?.[1] ?? "";
        expect(yield* fs.readFileString(kept).pipe(Effect.orDie)).toBe(
          `Attached: ${dir}/my shot.png\nAttached: ${dir}/log.txt`,
        );

        expect(yield* attachFiles(env, typing("/nowhere/at-all.png"), runId)).toContain(
          "attachment /nowhere/at-all.png does not exist",
        );
      }),
    ),
  120_000,
);

test(
  "the board's Attach files… on a Run with no live agent says to use Follow up",
  () =>
    steerable("collie-attach-board-gone-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { env, runId, agent } = yield* finishedWithAgent(world);
        yield* Effect.promise(() =>
          Bun.$`${Bun.env.HERDR_BIN_PATH!} pane close ${agent.pane_id}`.quiet(),
        );
        yield* fs.writeFileString(`${world.project}/shot.png`, "png").pipe(Effect.orDie);

        const note = yield* attachFiles(env, typing(`${world.project}/shot.png`), runId);
        expect(note).toContain("Nothing was delivered");
        expect(note).toContain('follow-up offer "carry-on"');
      }),
    ),
  120_000,
);

test(
  "a steer that names nobody reaches a finished Run's builder, not the reviewer launched after it, and says it was observed",
  () =>
    steerable(
      "collie-finished-builder-",
      (world) =>
        Effect.gen(function* () {
          const { env, runId } = yield* finishedWithAgent(world, "steered");
          const [done] = yield* carryOutAsked(
            env,
            [{ kind: "deliver", run: runId, text: "merge it", mode: "boundary" }],
            chat(),
          );
          expect(done?.state).toBe("applied");
          expect(done?.note).toMatch(
            /^Delivered to run-\S+-build-r1 \(observed: a turn started\)\.$/,
          );
          const [reviewer] = yield* carryOutAsked(
            env,
            [{ kind: "deliver", run: runId, to: "reviewer", text: "look again", mode: "boundary" }],
            chat(),
          );
          expect(reviewer?.note).toMatch(/^Delivered to run-\S+-review-r1 /);
        }),
      [{ verdict: "built" }, { verdict: "reviewed" }],
      ["steered.workflow.ts"],
    ),
  120_000,
);
