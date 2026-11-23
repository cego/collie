import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { platformLayer } from "../src/platform";
import type { Path, Scope } from "effect";
import { Effect, FileSystem, Schema, Stream, flow, Result } from "effect";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import { codexDriver, readCodexModels } from "../desktop/src/bun/codex-driver";
import { loopbackTools } from "../desktop/src/bun/chat-endpoint";
import type { DriverContext } from "../desktop/src/bun/driver";
import { type AguiEvent, ends } from "../desktop/src/shared/agui";
import { aboutNote } from "../desktop/src/shared/chat-view";
import { offersOf, opensOn } from "../desktop/src/bun/chat-choices";
import { harnessLists } from "../desktop/src/bun/harness-lists";
import { changeSettings } from "../desktop/src/bun/settings";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";

const FIXTURE = ["bun", `${import.meta.dir}/fixtures/codex-app-server.ts`];
let answers: Readonly<Record<string, string>> | null = null;

const withCodex = <A, E>(
  body: (
    driver: ReturnType<typeof codexDriver>,
    context: DriverContext,
  ) => Effect.Effect<
    A,
    E,
    Scope.Scope | SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "flock-codex-" });
      const services = yield* Effect.context<SecureRandom.SecureRandom | FileSystem.FileSystem>();
      const context: DriverContext = {
        dir,
        run: Effect.runPromiseWith(services),
        flock: {
          machines: () => [],
          conversation: "flock@test",
          said: () => "Hi",
          attachments: () => undefined,
          uploaded: new Map(),
          machineRule: () => "",
          setMachineRule: () => Effect.void,
          standingDirection: () => undefined,
          setStandingDirection: () => Effect.succeed(null),
          inSync: () => Effect.succeed(""),
          chatHarness: () => ({ harness: "codex", model: undefined, effort: undefined }),
          chatChoices: Effect.die("not asked"),
          setChatHarness: () => Effect.succeed(null),
        },
        ask: () => Promise.resolve(answers),
        noticed: () => "A Run ended",
        placement: () => ({ rule: "Here", machines: [] }),
      };
      const endpoint = yield* loopbackTools(context);
      return yield* body(codexDriver(context, endpoint, FIXTURE), context);
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  );

const turn = (session: Effect.Success<ReturnType<ReturnType<typeof codexDriver>["open"]>>) =>
  Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)));

const Inspected = Schema.fromJsonString(
  Schema.Struct({
    args: Schema.Array(Schema.String),
    cwd: Schema.String,
    hasToken: Schema.Boolean,
    thread: Schema.String,
    start: Schema.Record(Schema.String, Schema.Json),
    turn: Schema.Record(Schema.String, Schema.Json),
  }),
);
const inspected = (events: ReadonlyArray<AguiEvent>) => {
  const text = Option.getOrUndefined(
    Arr.findFirst(events, (event) => event.type === "TEXT_MESSAGE_CONTENT"),
  );
  if (text?.type !== "TEXT_MESSAGE_CONTENT") throw new Error("No reply");
  return flow(Schema.decodeResult(Inspected), Result.getOrThrow)(text.delta);
};

test("Codex streams a turn's reasoning, text and one row per tool, refuses what it asks the chat to answer, and costs its usage", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      const session = yield* driver.open("codex-hello", "default", null);
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("hello");
      const events = yield* turn(session);
      expect(events[0]).toMatchObject({ type: "RUN_STARTED", threadId: "codex-hello" });
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      expect(Arr.map(events, (event) => event.type)).toEqual([
        "RUN_STARTED",
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
        "RUN_FINISHED",
      ]);
      expect(Arr.filter(events, (event) => event.type === "TOOL_CALL_START")).toMatchObject([
        { toolCallName: "mcp__collie__collie_herd" },
        { toolCallName: "Bash" },
      ]);
      expect(Arr.filter(events, (event) => event.type === "TOOL_CALL_ARGS")).toMatchObject([
        { delta: "{}" },
        { delta: '{"command":"ls"}' },
      ]);
      expect(Arr.filter(events, (event) => event.type === "TOOL_CALL_RESULT")).toMatchObject([
        { content: "No Herds" },
        { content: "notes.md\n" },
      ]);
      expect(session.lastTurn()?.usage).toEqual({
        input_tokens: 10,
        output_tokens: 7,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 0,
      });
      expect(session.limited()).toBe(false);
    }),
  ));

test("Codex runs in Desktop's directory unasked and unsandboxed, with Collie's prompt, Collie's tools by token, the set model and effort, the human's images and Desktop's note", () =>
  withCodex((driver, context) =>
    Effect.gen(function* () {
      const session = yield* driver.open("codex-start", "gpt-6.2-sol", "high");
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer([
        { type: "text", text: "inspect" },
        { type: "text", text: aboutNote({ machine: "vm", task: "t", run: "r", name: "Card" }) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "c2hvdA==" } },
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
          title: "spec.pdf",
        },
      ]);
      const details = inspected(yield* turn(session));
      expect(details.cwd).toBe(context.dir);
      expect(details.hasToken).toBe(true);
      expect(details.args[0]).toBe("app-server");
      expect(details.args).toContain(
        'mcp_servers.collie_desktop.bearer_token_env_var="COLLIE_CHAT_MCP_TOKEN"',
      );
      expect(details.args).toContain("mcp_servers.collie_desktop.tool_timeout_sec=86400");
      expect(Arr.join(details.args, " ")).toMatch(
        /mcp_servers\.collie_desktop\.url="http:\/\/127\.0\.0\.1:\d+\/mcp"/,
      );
      expect(details.start).toMatchObject({
        cwd: context.dir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(details.start.developerInstructions).toEqual(
        expect.stringContaining("You are Collie"),
      );
      expect(details.turn).toMatchObject({ model: "gpt-6.2-sol", effort: "high" });
      const input = flow(
        Schema.encodeResult(Schema.fromJsonString(Schema.Json)),
        Result.getOrThrow,
      )(details.turn.input ?? null);
      expect(input).not.toContain("cGRm");
      const [said, card, image, note, ...rest] = flow(
        Schema.decodeResult(
          Schema.fromJsonString(
            Schema.Array(
              Schema.Struct({
                type: Schema.String,
                text: Schema.optionalKey(Schema.String),
                url: Schema.optionalKey(Schema.String),
              }),
            ),
          ),
        ),
        Result.getOrThrow,
      )(input);
      expect(said).toEqual({ type: "text", text: "inspect" });
      expect(card?.text).toContain('"name":"Card"');
      expect(image).toEqual({ type: "image", url: "data:image/png;base64,c2hvdA==" });
      expect(note?.text).toContain("Here");
      expect(note?.text).toContain("A Run ended");
      expect(rest).toEqual([]);
    }),
  ));

test("Codex's own default model and effort are left to it", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      const session = yield* driver.open("codex-default", "default", null);
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("inspect");
      const details = inspected(yield* turn(session));
      expect(details.turn.model).toBeUndefined();
      expect(details.turn.effort).toBeUndefined();
    }),
  ));

test("A question Codex puts through Collie's AskUserQuestion shows as one and is answered by the human's click", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      answers = { "Where?": "Here" };
      const session = yield* driver.open("codex-question", "default", null);
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("question");
      const events = yield* turn(session);
      answers = null;
      expect(Arr.filter(events, (event) => event.type === "TOOL_CALL_START")).toMatchObject([
        { toolCallName: "AskUserQuestion" },
      ]);
      const result = Option.getOrUndefined(
        Arr.findFirst(events, (event) => event.type === "TOOL_CALL_RESULT"),
      );
      expect(result).toMatchObject({ content: expect.stringContaining('"Where?":"Here"') });
    }),
  ));

test("Interrupting ends the turn under way as finished, and the session takes the next message", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      const session = yield* driver.open("codex-stop", "default", null);
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("wait");
      const first = yield* Stream.runCollect(
        session.events.pipe(
          Stream.tap((event) =>
            event.type === "RUN_STARTED"
              ? session.interrupt.pipe(Effect.delay("200 millis"))
              : Effect.void,
          ),
          Stream.takeUntil(ends),
        ),
      );
      expect(first.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      yield* session.offer("hello");
      expect((yield* turn(session)).at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    }),
  ));

test("A conversation reopened resumes its Codex thread, and its transcript and history read it back without Desktop's note", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      const first = yield* driver.open("codex-again", "default", null);
      yield* first.offer("inspect");
      const thread = inspected(yield* turn(first)).thread;
      yield* first.close;
      const again = yield* driver.open("codex-again", "default", null);
      yield* Effect.addFinalizer(() => again.close);
      yield* again.offer("inspect");
      expect(inspected(yield* turn(again)).thread).toBe(thread);
      const transcript = yield* driver.transcript("codex-again");
      expect(Arr.map(transcript, ({ role }) => role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(transcript[0]?.parts).toEqual([{ type: "text", content: "inspect" }]);
      const earlier = yield* driver.earlier(10);
      expect(earlier).toMatchObject([{ session: "codex-again", title: "hello there" }]);
      expect(yield* driver.transcriptPath("codex-again")).toEndWith(`${thread}.jsonl`);
    }),
  ));

test("An earlier Codex thread Desktop did not start is opened by its own id", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      const first = yield* driver.open("desktop-id", "default", null);
      yield* first.offer("inspect");
      const thread = inspected(yield* turn(first)).thread;
      yield* first.close;
      const opened = yield* driver.open(thread, "default", null);
      yield* Effect.addFinalizer(() => opened.close);
      yield* opened.offer("inspect");
      expect(inspected(yield* turn(opened)).thread).toBe(thread);
    }),
  ));

test("A Codex that is not signed in says how to sign in, before any turn", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      Bun.env.FAKE_CODEX_SIGNED_OUT = "1";
      yield* Effect.addFinalizer(() => Effect.sync(() => delete Bun.env.FAKE_CODEX_SIGNED_OUT));
      const session = yield* driver.open("codex-signed-out", "default", null);
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("hello");
      const ended = yield* session.events.pipe(Stream.runDrain, Effect.flip);
      expect(String(ended)).toBe(
        "Codex is not signed in on this computer: run `codex login` in a terminal, then send your message again.",
      );
    }),
  ));

test("A failed turn says Codex's error, a usage limit marks the session limited, and an unauthorized one says how to sign in", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      const session = yield* driver.open("codex-limit", "default", null);
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("limit");
      expect((yield* turn(session)).at(-1)).toMatchObject({
        type: "RUN_ERROR",
        message: "You've hit your usage limit.",
      });
      expect(session.limited()).toBe(true);
      yield* session.offer("signed-out");
      expect((yield* turn(session)).at(-1)).toMatchObject({
        type: "RUN_ERROR",
        message: "Unauthorized: run `codex login` in a terminal, then send your message again.",
      });
      expect(session.limited()).toBe(false);
    }),
  ));

test("A Codex that exits ends the session with what it said", () =>
  withCodex((driver) =>
    Effect.gen(function* () {
      const session = yield* driver.open("codex-crash", "default", null);
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("crash");
      const ended = yield* session.events.pipe(Stream.runDrain, Effect.flip);
      expect(String(ended)).toBe("codex: the model provider refused the connection");
    }),
  ));

test("Without codex on PATH the driver is not installed", () =>
  withCodex((_, context) =>
    Effect.gen(function* () {
      const endpoint = yield* loopbackTools(context);
      expect(codexDriver(context, endpoint, null).installed).toBe(false);
    }),
  ));

test("Codex's model list offers its visible models with their efforts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "codex-models-" });
      expect(yield* readCodexModels(dir, FIXTURE)).toEqual([
        {
          id: "gpt-6.2-sol",
          label: "GPT-6.2-Sol",
          description: "Fast, go-to model.",
          efforts: ["low", "high"],
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  ));

test("Codex can be chosen for the chat, offering its own models, and opens on the model and effort chosen", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "codex-choice-" });
      const lists = yield* harnessLists({ codex: readCodexModels(dir, FIXTURE) });
      yield* lists.ready("codex");
      const offers = yield* offersOf(
        { proactive: true },
        NO_FLOCK_SETTINGS,
        Effect.succeed({}),
        lists,
      );
      expect(offers.codex).toMatchObject({
        from: "harness",
        unset: { harness: "codex", model: "default", effort: null },
        models: [{ id: "gpt-6.2-sol", efforts: ["low", "high"], unsetEffort: "medium" }],
      });
      const saved = changeSettings(
        { proactive: true },
        NO_FLOCK_SETTINGS,
        { chatHarness: "codex", chatModel: "gpt-6.2-sol", chatEffort: "high" },
        offers,
      );
      expect(saved).toEqual({
        proactive: true,
        chatHarness: "codex",
        chatModel: "gpt-6.2-sol",
        chatEffort: "high",
      });
      if ("refused" in saved) return;
      expect(yield* opensOn(saved, NO_FLOCK_SETTINGS, Effect.succeed({}), lists)).toEqual({
        ok: true,
        choice: { harness: "codex", model: "gpt-6.2-sol", effort: "high" },
      });
      expect(changeSettings(saved, NO_FLOCK_SETTINGS, { chatEffort: "max" }, offers)).toMatchObject(
        { refused: expect.stringContaining("low, high") },
      );
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  ));
