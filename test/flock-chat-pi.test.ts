import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { platformLayer } from "../src/platform";
import { Effect, FileSystem, Path, Schema, Scope, Stream, flow, Result } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { piDriver } from "../desktop/src/bun/pi-driver";
import { loopbackTools } from "../desktop/src/bun/chat-endpoint";
import type { DriverContext } from "../desktop/src/bun/driver";
import { openFlockChat } from "../desktop/src/bun/chat";
import { aboutNote } from "../desktop/src/shared/chat-view";
import { FLOCK_TOOLS } from "../desktop/src/bun/flock-tools";
import { FILE_TOOLS } from "../desktop/src/bun/file-tools";
import { piPrompt } from "../desktop/src/bun/pi-transcript";
import { type AguiEvent, ends } from "../desktop/src/shared/agui";
import { childEnv } from "../desktop/src/bun/login-env";
import { offerOf, opensOn, readPiConfig } from "../desktop/src/bun/chat-choices";
import { PiConfig } from "../desktop/src/shared/chat-choices";
import type { DesktopSettings } from "../desktop/src/shared/flock";
import { NO_FLOCK_SETTINGS, takeFrom } from "../desktop/src/shared/flock-settings";
import { harnessLists } from "../desktop/src/bun/harness-lists";
import { readPiModels } from "../desktop/src/bun/pi-models";
import { changeSettings } from "../desktop/src/bun/settings";
import { chatSelects, choiceNotices } from "../desktop/src/shared/chat-choices";
import { callFlockTool } from "../desktop/src/bun/flock-tools";
import type { UserMcpServers } from "../desktop/src/bun/session";
import { PiServer, piServers } from "../desktop/src/bun/pi-servers";

let direction: { readonly text: string; readonly at: string } | undefined;
let userServers: UserMcpServers = {};
const FIXTURE = ["bun", `${import.meta.dir}/fixtures/pi-chat.ts`];

const withPi = <A, E>(
  body: (
    driver: ReturnType<typeof piDriver>,
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
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "flock-pi-" });
      const env = Bun.env;
      const previous = env.PI_CODING_AGENT_DIR;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete env.PI_CODING_AGENT_DIR;
          else env.PI_CODING_AGENT_DIR = previous;
        }),
      );
      env.PI_CODING_AGENT_DIR = `${dir}/agent`;
      yield* fs.makeDirectory(env.PI_CODING_AGENT_DIR);
      expect(childEnv().PI_CODING_AGENT_DIR).toBe(`${dir}/agent`);
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
          standingDirection: () => direction,
          setStandingDirection: () => Effect.succeed(null),
          inSync: () => Effect.succeed(""),
          chatHarness: () => ({ harness: "pi", model: undefined, effort: undefined }),
          chatChoices: Effect.die("not asked"),
          setChatHarness: () => Effect.succeed(null),
        },
        ask: () => Promise.resolve(null),
        noticed: () => "A Run ended",
        placement: () => ({ rule: "Here", machines: [] }),
      };
      const endpoint = yield* loopbackTools(context);
      const driver = piDriver(context, endpoint, () => Promise.resolve(userServers), FIXTURE);
      return yield* body(driver, context);
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  );

test("Pi streams text including Unicode separators, thinking and one row per tool, ending at agent_settled", () =>
  withPi((driver) =>
    Effect.gen(function* () {
      const session = yield* driver.open("pi-conversation", "openai-codex/gpt-6.1-sol", "medium");
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("Hi");
      const events = yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)));
      expect(events[0]).toMatchObject({ type: "RUN_STARTED", threadId: "pi-conversation" });
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      expect(Arr.filter(events, (event) => event.type === "TEXT_MESSAGE_CONTENT")).toMatchObject([
        { delta: "Hello\u2028world\u2029!" },
        { delta: "After agent_end" },
      ]);
      expect(
        Arr.filter(events, (event) => event.type === "REASONING_MESSAGE_CONTENT"),
      ).toMatchObject([{ delta: "Considering" }]);
      expect(Arr.filter(events, (event) => event.type === "TOOL_CALL_START")).toMatchObject([
        { toolCallId: "herd", toolCallName: "mcp__collie__collie_herd" },
      ]);
      expect(Arr.filter(events, (event) => event.type === "TOOL_CALL_RESULT")).toMatchObject([
        { toolCallId: "herd", content: "No Herds" },
      ]);
      expect(session.lastTurn()?.usage).toEqual({
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      });
    }),
  ));

test("Pi's start isolates resources, keeps the token in its environment and sends images and Desktop's note", () =>
  withPi((driver, context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${context.dir}/.pi`);
      for (const dir of [childEnv().PI_CODING_AGENT_DIR!, `${context.dir}/.pi`]) {
        yield* fs.writeFileString(`${dir}/SYSTEM.md`, "Personal system instructions");
        yield* fs.writeFileString(`${dir}/APPEND_SYSTEM.md`, "Personal appended instructions");
      }
      const session = yield* driver.open("pi-start", "openai-codex/gpt-6.1-sol", "medium");
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer([
        { type: "text", text: "inspect" },
        { type: "text", text: "note.txt:\nHello" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "c2hvdA==" } },
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
          title: "spec.pdf",
        },
      ]);
      const events = yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)));
      const text = Option.getOrUndefined(
        Arr.findFirst(events, (event) => event.type === "TEXT_MESSAGE_CONTENT"),
      );
      if (text?.type !== "TEXT_MESSAGE_CONTENT") return yield* Effect.die(new Error("No reply"));
      const details = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            args: Schema.Array(Schema.String),
            cwd: Schema.String,
            hasToken: Schema.Boolean,
            extension: Schema.String,
            systemPrompt: Schema.String,
            prompt: Schema.Struct({ message: Schema.String, images: Schema.Array(Schema.Json) }),
          }),
        ),
      )(text.delta).pipe(Effect.orDie);
      expect(details.cwd).toBe(context.dir);
      expect(details.args).toEqual([
        "--mode",
        "rpc",
        "--session-dir",
        `${context.dir}/pi-sessions`,
        "--session-id",
        "pi-start",
        "--system-prompt",
        expect.stringContaining("You are Collie"),
        "--append-system-prompt",
        "",
        "--no-extensions",
        "-e",
        "builtin:tool-search",
        "-e",
        "builtin:mcp",
        "-e",
        `${context.dir}/pi-collie.ts`,
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--tools",
        "read,bash,edit,write,grep,find,ls,tool_search,mcp__*",
        "--model",
        "openai-codex/gpt-6.1-sol",
        "--thinking",
        "medium",
      ]);
      expect(details.hasToken).toBe(true);
      expect(details.systemPrompt).toContain("You are Collie");
      expect(details.systemPrompt).not.toContain("Personal");
      expect(details.extension).toContain("process.env.COLLIE_CHAT_MCP_TOKEN");
      expect(details.extension).toContain("timeout: 86400");
      const prefix = `mcp__${pipe_(
        /registerMcpServer\("(cf-[0-9a-f]{32})"/.exec(details.extension)![1]!,
        Str.replaceAll("-", "_"),
      )}__`;
      for (const name of Arr.map(
        [...FLOCK_TOOLS, ...FILE_TOOLS, { name: "AskUserQuestion" }],
        (tool) => tool.name,
      ))
        expect(`${prefix}${name}`.length).toBeLessThanOrEqual(64);
      expect(details.extension).toMatch(/registerMcpServer\("cf-[0-9a-f]{32}"/);
      expect(details.prompt.images).toEqual([
        { type: "image", data: "c2hvdA==", mimeType: "image/png" },
      ]);
      expect(details.prompt.message).toContain("note.txt:");
      expect(details.prompt.message).toContain("Here");
      expect(details.prompt.message).toContain("A Run ended");
      expect(details.prompt.message).not.toContain("cGRm");
    }),
  ));

test("Pi's note carries the Standing direction's words and date beside the Machine rule, and leaves it out while empty", () =>
  withPi((driver) =>
    Effect.gen(function* () {
      const noteOf = (id: string) =>
        Effect.gen(function* () {
          const session = yield* driver.open(id, "openai-codex/gpt-6.1-sol", "medium");
          yield* session.offer("inspect");
          const events = yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)));
          yield* session.close;
          const text = Option.getOrUndefined(
            Arr.findFirst(events, (event) => event.type === "TEXT_MESSAGE_CONTENT"),
          );
          if (text?.type !== "TEXT_MESSAGE_CONTENT")
            return yield* Effect.die(new Error("No reply"));
          return (yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({ prompt: Schema.Struct({ message: Schema.String }) }),
            ),
          )(text.delta).pipe(Effect.orDie)).prompt.message;
        });
      direction = {
        text: "Stage only; production waits for my go.",
        at: "2026-11-03T09:30:00.000Z",
      };
      const kept = yield* noteOf("pi-standing");
      expect(kept).toContain("Stage only; production waits for my go.");
      expect(kept).toContain("2026-11-03");
      expect(kept).toContain("Here");
      direction = { text: "", at: "2026-11-04T10:00:00.000Z" };
      const cleared = yield* noteOf("pi-standing-cleared");
      expect(cleared).toContain("Here");
      expect(Str.toLowerCase(cleared)).not.toContain("standing direction");
      direction = undefined;
    }),
  ));

const inspected = (events: ReadonlyArray<AguiEvent>) => {
  const text = Option.getOrUndefined(
    Arr.findFirst(events, (event) => event.type === "TEXT_MESSAGE_CONTENT"),
  );
  if (text?.type !== "TEXT_MESSAGE_CONTENT") throw new Error("No reply");
  return flow(
    Schema.decodeResult(
      Schema.fromJsonString(
        Schema.Struct({
          args: Schema.Array(Schema.String),
          model: Schema.String,
          thinking: Schema.String,
        }),
      ),
    ),
    Result.getOrThrow,
  )(text.delta);
};

const writePiConfig = (config: PiConfig) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(
      `${childEnv().PI_CODING_AGENT_DIR}/settings.json`,
      flow(Schema.encodeResult(Schema.fromJsonString(PiConfig)), Result.getOrThrow)(config),
    ),
  );

const startedWith = (
  driver: ReturnType<typeof piDriver>,
  context: DriverContext,
  settings: DesktopSettings,
) =>
  Effect.gen(function* () {
    const opened = yield* opensOn(settings, NO_FLOCK_SETTINGS, readPiConfig(context.dir));
    if (!opened.ok) return yield* Effect.die(opened.problem);
    const session = yield* driver.open("pi-effort", opened.choice.model, opened.choice.effort);
    yield* session.offer("inspect");
    const events = yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)));
    yield* session.close;
    const { args } = inspected(events);
    return args.slice(args.indexOf("--no-context-files") + 3);
  });

test("Pi starts at the chat's set effort, and with nothing configured on its own model at medium", () =>
  withPi((driver, context) =>
    Effect.gen(function* () {
      const model = "openai-codex/gpt-6.1-sol";
      expect(
        yield* startedWith(driver, context, {
          proactive: true,
          chatHarness: "pi",
          chatModel: model,
          chatEffort: "high",
        }),
      ).toEqual(["--model", model, "--thinking", "high"]);
      expect(yield* startedWith(driver, context, { proactive: true, chatHarness: "pi" })).toEqual([
        "--thinking",
        "medium",
      ]);
    }),
  ));

test("Pi starts a set model at the level its configuration names for it while the effort is unset", () =>
  withPi((driver, context) =>
    Effect.gen(function* () {
      const model = "openai-codex/gpt-5.5";
      yield* writePiConfig({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-6.1-sol",
        defaultThinkingLevel: "low",
        modelThinkingLevels: { [model]: "xhigh" },
      });
      expect(
        yield* startedWith(driver, context, {
          proactive: true,
          chatHarness: "pi",
          chatModel: model,
        }),
      ).toEqual(["--model", model, "--thinking", "xhigh"]);
      expect(yield* startedWith(driver, context, { proactive: true, chatHarness: "pi" })).toEqual([
        "--model",
        "openai-codex/gpt-6.1-sol",
        "--thinking",
        "low",
      ]);
    }),
  ));

test("Pi's own per-model levels constrain settings, selects, the tool and the session's configured default", () =>
  withPi((driver, context) =>
    Effect.gen(function* () {
      const lists = yield* harnessLists({
        pi: readPiModels(NO_FLOCK_SETTINGS, context.dir, [
          "bun",
          `${import.meta.dir}/fixtures/pi-models.ts`,
          "list",
        ]),
      });
      yield* lists.ready("pi");
      for (const { model, configured, expected, label } of [
        {
          model: "openai-codex/gpt-5.5",
          configured: "max",
          expected: "xhigh",
          label: "Default · Extra high",
        },
        {
          model: "openai-codex/gpt-6.1-sol",
          configured: "off",
          expected: "minimal",
          label: "Default · Minimal",
        },
        {
          model: "openai-codex/gpt-5.5",
          configured: "high",
          expected: "high",
          label: "Default · High",
        },
      ]) {
        yield* writePiConfig({
          defaultProvider: "openai-codex",
          defaultModel: "gpt-6.1-sol",
          defaultThinkingLevel: "max",
          modelThinkingLevels: { [model]: configured },
        });
        const settings: DesktopSettings = { proactive: true, chatHarness: "pi", chatModel: model };
        const choice = yield* opensOn(
          settings,
          NO_FLOCK_SETTINGS,
          readPiConfig(context.dir),
          lists,
        );
        expect(choice).toEqual({ ok: true, choice: { harness: "pi", model, effort: expected } });
        if (!choice.ok) return yield* Effect.die(choice.problem);
        const session = yield* driver.open("clamped", choice.choice.model, choice.choice.effort);
        yield* session.offer("inspect");
        const inspectedSession = inspected(
          yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends))),
        );
        yield* session.close;
        expect(inspectedSession).toMatchObject({ model, thinking: expected });
        const offered = yield* offerOf(
          "pi",
          settings,
          NO_FLOCK_SETTINGS,
          readPiConfig(context.dir),
          lists,
        );
        if (offered.from === "reading") return yield* Effect.die("List did not finish");
        const account = {
          heldOn: "pi",
          runsOn: choice.choice,
          turning: false,
          harnesses: [{ harness: "pi", label: "Pi", installed: true, offered }],
        };
        const selects = chatSelects(settings, account);
        expect(selects.effort.options[0]?.label).toBe(label);
        expect(selects.model.note).toBe("Listed by Pi on this computer");
        expect(Arr.map(selects.model.options, ({ label }) => label)).toContain("GPT-5.5");
        const said = yield* callFlockTool(
          {
            ...context.flock,
            chatHarness: () => ({ harness: "pi", model, effort: undefined }),
            chatChoices: Effect.succeed(account),
          },
          "collie_chat_harness",
          {},
        );
        expect(said).toContain(
          "pi offers openai-codex/gpt-5.5 (off, minimal, low, medium, high, xhigh), openai-codex/gpt-6.1-sol (minimal, low, medium, high, xhigh, max), local/only-off (no effort), local/plain (no effort).",
        );
        const offers = { pi: offered };
        expect(
          changeSettings(
            settings,
            NO_FLOCK_SETTINGS,
            { chatModel: "openai-codex/gpt-5.5", chatEffort: "max" },
            offers,
          ),
        ).toEqual({
          refused:
            '"max" is not an effort this computer\'s pi/openai-codex/gpt-5.5 takes (off, minimal, low, medium, high, xhigh)',
        });
        expect(
          changeSettings(
            { ...settings, chatModel: "openai-codex/gpt-6.1-sol", chatEffort: "max" },
            NO_FLOCK_SETTINGS,
            { chatModel: "openai-codex/gpt-5.5" },
            offers,
          ),
        ).toEqual({ proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-5.5" });
      }
    }),
  ));

test("an added unlisted Pi model's configured default agrees in the session, selects, notice and tool", () =>
  withPi((driver, context) =>
    Effect.gen(function* () {
      const model = "openai-codex/gpt-6-astra";
      yield* writePiConfig({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-6.1-sol",
        defaultThinkingLevel: "low",
        modelThinkingLevels: { [model]: "high" },
      });
      const lists = yield* harnessLists({
        pi: readPiModels(NO_FLOCK_SETTINGS, context.dir, [
          "bun",
          `${import.meta.dir}/fixtures/pi-models.ts`,
          "list",
        ]),
      });
      const settings: DesktopSettings = { proactive: true, chatHarness: "pi", chatModel: model };
      const absent = yield* opensOn(settings, NO_FLOCK_SETTINGS, readPiConfig(context.dir), lists);
      expect(!absent.ok && absent.problem).toContain('has no model "openai-codex/gpt-6-astra"');
      const flock = takeFrom(NO_FLOCK_SETTINGS, "vm-gpu", [
        { key: "models.pi", value: [model], at: "2026-10-29T09:00:00.000Z" },
      ]).flock;
      const opened = yield* opensOn(settings, flock, readPiConfig(context.dir), lists);
      expect(opened).toEqual({ ok: true, choice: { harness: "pi", model, effort: "high" } });
      if (!opened.ok) return yield* Effect.die(opened.problem);
      const session = yield* driver.open(
        "typed-default",
        opened.choice.model,
        opened.choice.effort,
      );
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("inspect");
      expect(
        inspected(yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)))),
      ).toMatchObject({
        model,
        thinking: "high",
      });
      const offered = yield* offerOf("pi", settings, flock, readPiConfig(context.dir), lists);
      const account = {
        heldOn: "pi",
        runsOn: { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "low" },
        turning: true,
        harnesses: [{ harness: "pi", label: "Pi", installed: true, offered }],
      };
      expect(chatSelects(settings, account).effort.label).toBe("Default · High");
      expect(choiceNotices(settings, account).reply?.next).toBe("openai-codex/gpt-6-astra · High");
      expect(choiceNotices(settings, { ...account, runsOn: opened.choice }).reply).toBeNull();
      expect(
        yield* callFlockTool(
          {
            ...context.flock,
            chatHarness: () => ({ harness: "pi", model, effort: undefined }),
            chatChoices: Effect.succeed(account),
          },
          "collie_chat_harness",
          {},
        ),
      ).toContain("model openai-codex/gpt-6-astra, with no effort set, so it runs at high");
    }),
  ));

test("Pi's configuration is read as a session opens, so a level changed since Desktop started is used", () =>
  withPi((_, context) =>
    Effect.gen(function* () {
      const settings: DesktopSettings = { proactive: false, chatHarness: "pi" };
      yield* writePiConfig({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-6.1-sol",
        defaultThinkingLevel: "high",
      });
      const conversation = yield* openFlockChat({
        dir: context.dir,
        conversation: "flock@test",
        machines: () => [],
        proactive: () => false,
        machineRule: () => "",
        setMachineRule: () => Effect.void,
        standingDirection: () => undefined,
        setStandingDirection: () => Effect.succeed(null),
        inSync: () => Effect.succeed(""),
        choice: () => opensOn(settings, NO_FLOCK_SETTINGS, readPiConfig(context.dir)),
        offered: (harness) =>
          offerOf(harness, settings, NO_FLOCK_SETTINGS, readPiConfig(context.dir)),
        retold: Stream.empty,
        chatHarness: () => ({ harness: "pi", model: undefined, effort: undefined }),
        setChatHarness: () => Effect.succeed(null),
        drivers: (opened) =>
          loopbackTools(opened).pipe(
            Effect.map((endpoint) => ({
              pi: piDriver(opened, endpoint, () => Promise.resolve({}), FIXTURE),
            })),
          ),
      });
      const first = inspected(yield* Stream.runCollect(conversation.send("inspect", null, false)));
      expect(first).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "high" });
      yield* writePiConfig({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-6.1-sol",
        defaultThinkingLevel: "xhigh",
      });
      const second = inspected(yield* Stream.runCollect(conversation.send("inspect", null, false)));
      expect(second).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "xhigh" });
      expect(
        second.args.slice(
          second.args.indexOf("--session-id"),
          second.args.indexOf("--session-id") + 2,
        ),
      ).toEqual(
        first.args.slice(
          first.args.indexOf("--session-id"),
          first.args.indexOf("--session-id") + 2,
        ),
      );
    }),
  ));

test("Pi reports its own error and abort ends a turn before another message starts", () =>
  withPi((driver) =>
    Effect.gen(function* () {
      const session = yield* driver.open("pi-abort", "default", "");
      yield* Effect.addFinalizer(() => session.close);
      yield* session.offer("hold");
      const started = yield* Stream.runCollect(session.events.pipe(Stream.take(1)));
      expect(started[0]?.type).toBe("RUN_STARTED");
      yield* session.interrupt;
      expect(
        (yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)))).at(-1)?.type,
      ).toBe("RUN_FINISHED");
      yield* session.offer("error");
      expect(
        (yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)))).at(-1),
      ).toMatchObject({ type: "RUN_ERROR", message: "Model is not available on this provider" });
      yield* session.offer("Hi again");
      expect(
        (yield* Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)))).at(-1)?.type,
      ).toBe("RUN_FINISHED");
    }),
  ));

test("Pi reads its own session tree, preserves the card pill and files, and hides Desktop's context", () =>
  withPi((driver, context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${context.dir}/pi-sessions`);
      const about = { machine: "local", task: "t1", run: "r1", name: "Work" };
      const prompt = piPrompt(
        [
          { type: "text", text: "human words" },
          { type: "text", text: aboutNote(about) },
        ],
        "The Machine rule: Here. News: ended.",
      );
      const entries = [
        {
          type: "session",
          version: 3,
          id: "pi-history",
          timestamp: "2026-10-09T00:00:00Z",
          cwd: context.dir,
        },
        {
          type: "message",
          id: "human",
          parentId: null,
          timestamp: "2026-10-09T00:00:01Z",
          message: { role: "user", content: prompt.message },
        },
        {
          type: "message",
          id: "abandoned",
          parentId: "human",
          timestamp: "2026-10-09T00:00:02Z",
          message: { role: "assistant", content: [{ type: "text", text: "Old branch" }] },
        },
        {
          type: "message",
          id: "reply",
          parentId: "human",
          timestamp: "2026-10-09T00:00:03Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Thought" },
              {
                type: "toolCall",
                id: "ask",
                name: "mcp__cf_ffffffffffffffffffffffffffffffff__AskUserQuestion",
                arguments: { questions: [] },
              },
            ],
          },
        },
        {
          type: "message",
          id: "result",
          parentId: "reply",
          timestamp: "2026-10-09T00:00:04Z",
          message: {
            role: "toolResult",
            toolCallId: "ask",
            content: [{ type: "text", text: "Here" }],
          },
        },
        {
          type: "session_info",
          id: "name",
          parentId: "result",
          timestamp: "2026-10-09T00:00:05Z",
          name: "Named conversation",
        },
      ];
      const path = `${context.dir}/pi-sessions/date_pi-history.jsonl`;
      yield* fs.writeFileString(
        path,
        Arr.join(
          Arr.map(entries, (entry) => JSON.stringify(entry)),
          "\n",
        ) + "\n",
      );
      const transcript = yield* driver.transcript("pi-history");
      expect(transcript).toMatchObject([
        { role: "user", parts: [{ type: "text", content: "human words" }], metadata: { about } },
        {
          role: "assistant",
          parts: [
            { type: "thinking", content: "Thought" },
            { type: "tool-call", id: "ask", name: "AskUserQuestion", output: "Here" },
          ],
        },
      ]);
      expect(yield* driver.earlier(10)).toMatchObject([
        { session: "pi-history", title: "Named conversation" },
      ]);
      expect(yield* driver.transcriptPath("pi-history")).toBe(path);
    }),
  ));

test("a question's buttons can be clicked before Pi's HTTP call reaches Desktop", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "flock-pi-question-" });
      const conversation = yield* openFlockChat({
        dir,
        conversation: "flock@test",
        machines: () => [],
        proactive: () => false,
        machineRule: () => "",
        setMachineRule: () => Effect.void,
        standingDirection: () => undefined,
        setStandingDirection: () => Effect.succeed(null),
        inSync: () => Effect.succeed(""),
        choice: () =>
          Effect.succeed({ ok: true, choice: { harness: "pi", model: "default", effort: null } }),
        offered: (harness) =>
          offerOf(harness, { proactive: false }, NO_FLOCK_SETTINGS, Effect.succeed({})),
        retold: Stream.empty,
        chatHarness: () => ({ harness: "pi", model: undefined, effort: undefined }),
        setChatHarness: () => Effect.succeed(null),
        drivers: (context) =>
          loopbackTools(context).pipe(
            Effect.map((endpoint) => ({
              pi: piDriver(context, endpoint, () => Promise.resolve({}), FIXTURE),
            })),
          ),
      });
      const events = yield* conversation.send("question", null, false).pipe(
        Stream.tap((event) =>
          event.type === "TOOL_CALL_END"
            ? conversation.answer(event.toolCallId, { "Where?": "Here" })
            : Effect.void,
        ),
        Stream.runCollect,
      );
      expect(
        Option.getOrUndefined(Arr.findFirst(events, (event) => event.type === "TOOL_CALL_START")),
      ).toMatchObject({
        toolCallName: "AskUserQuestion",
      });
      expect(
        Option.getOrUndefined(Arr.findFirst(events, (event) => event.type === "TOOL_CALL_RESULT")),
      ).toMatchObject({
        content: expect.stringContaining("Here"),
      });
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  ));

/** Pi's `tool_call` event and its answer, as far as Collie's extension uses them. */
type ToolCallHandler = (
  event: { readonly toolName: string; readonly input: Readonly<Record<string, string>> },
  ctx: { readonly cwd: string },
) => { readonly block: true; readonly reason: string } | undefined;
interface PiApi {
  readonly registerMcpServer: () => void;
  readonly on: (event: string, handler: ToolCallHandler) => void;
}

test("Pi's file tools and shell are refused where the human's sessions are kept", () =>
  withPi((driver, context) =>
    Effect.gen(function* () {
      const session = yield* driver.open("pi-closed", "openai-codex/gpt-6.1-sol", "medium");
      yield* Effect.addFinalizer(() => session.close);
      const handlers = new Map<string, ToolCallHandler>();
      const extension = yield* Effect.promise(
        (): Promise<{ readonly default: (pi: PiApi) => void }> =>
          import(`${context.dir}/pi-collie.ts`),
      );
      extension.default({
        registerMcpServer: () => undefined,
        on: (event, handler) => handlers.set(event, handler),
      });
      const home = homedir();
      const call = (toolName: string, input: Readonly<Record<string, string>>) =>
        Effect.promise(() =>
          Promise.resolve(handlers.get("tool_call")!({ toolName, input }, { cwd: context.dir })),
        );
      const blocked = { block: true, reason: expect.stringContaining("Read my messages") };
      expect(yield* call("read", { path: `${home}/.claude/projects/-x/1.jsonl` })).toMatchObject(
        blocked,
      );
      expect(yield* call("bash", { command: "cat ~/.claude/history.jsonl" })).toMatchObject(
        blocked,
      );
      expect(yield* call("grep", { pattern: "deploy", path: home })).toMatchObject(blocked);
      expect(yield* call("read", { path: `${home}/work/notes.md` })).toBeUndefined();
      expect(yield* call("read", { path: `${home}/.claude/./projects/-x/1.jsonl` })).toMatchObject(
        blocked,
      );
      expect(
        yield* call("cf-0_collie_direction", {
          text: "Never read ~/.claude/projects without asking me.",
        }),
      ).toBeUndefined();
    }),
  ));

const configured: UserMcpServers = {
  "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" },
  docs: {
    type: "http",
    url: "https://docs.example/mcp",
    headers: { Authorization: "Bearer s3cr3t-value" },
  },
  legacy: { type: "sse", url: "https://legacy.example/sse" },
  refused: { command: "refused-mcp" },
};

const withServers = <A, E>(
  servers: UserMcpServers,
  body: Parameters<typeof withPi<A, E>>[0],
): Promise<A> => {
  userServers = servers;
  return withPi(body).finally(() => {
    userServers = {};
  });
};

const opened = (driver: ReturnType<typeof piDriver>, id: string) =>
  Effect.gen(function* () {
    const session = yield* driver.open(id, "openai-codex/gpt-6.1-sol", "medium");
    yield* Effect.addFinalizer(() => session.close);
    return (message: string) =>
      session
        .offer(message)
        .pipe(Effect.andThen(Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)))));
  });

const replies = (events: ReadonlyArray<AguiEvent>) =>
  Arr.flatMap(events, (event) => (event.type === "TEXT_MESSAGE_CONTENT" ? [event.delta] : []));

const Inspected = Schema.Struct({
  extension: Schema.String,
  systemPrompt: Schema.String,
  servers: Schema.String,
  prompt: Schema.Struct({ message: Schema.String }),
});
const inspectedOf = (events: ReadonlyArray<AguiEvent>) =>
  flow(
    Schema.decodeResult(Schema.fromJsonString(Inspected)),
    Result.getOrThrow,
  )(replies(events)[0]!);

test("Pi is handed the human's servers in its environment, never in the extension file, and is told of them", () =>
  withServers(configured, (driver) =>
    Effect.gen(function* () {
      const turn = yield* opened(driver, "pi-servers");
      const details = inspectedOf(yield* turn("inspect"));
      expect(
        flow(
          Schema.decodeResult(Schema.fromJsonString(Schema.Record(Schema.String, PiServer))),
          Result.getOrThrow,
        )(details.servers),
      ).toEqual(piServers(configured).given);
      expect(details.extension).not.toContain("s3cr3t");
      const prompt = pipe_(details.systemPrompt, Str.replace(/\s+/g, " "));
      expect(prompt).toContain("this chat has linear-server, docs, refused");
      expect(prompt).toContain("legacy (Pi does not speak SSE)");
      expect(prompt).toContain("/mcp login <server>");
    }),
  ));

type Notify = (message: string, kind: string) => void;
type SessionStart = (
  event: { readonly type: "session_start" },
  ctx: { readonly ui: { readonly notify: Notify } },
) => void;
type Registered = readonly [string, Schema.Json];
interface LoadedPi {
  readonly registerMcpServer: (name: string, config: Schema.Json) => void;
  readonly on: (event: string, handler: SessionStart) => void;
}

/** Pi as the extension meets it, refusing the server named `refused` as Pi refuses a name. */
const refusingPi = (registered: Registered[], started: SessionStart[]): LoadedPi => ({
  registerMcpServer: (name, config) => {
    if (name === "refused") throw new Error("names registered by another extension throw");
    registered.push([name, config]);
  },
  on: (event, handler) => {
    if (event === "session_start") started.push(handler);
  },
});

test("Collie's extension registers its server and the human's, survives one Pi refuses, and drops them from Pi's environment", () =>
  withServers(configured, (driver, context) =>
    Effect.gen(function* () {
      const turn = yield* opened(driver, "pi-extension");
      const { servers } = inspectedOf(yield* turn("inspect"));
      Bun.env.COLLIE_CHAT_MCP_SERVERS = servers;
      const registered: Registered[] = [];
      const started: SessionStart[] = [];
      const extension = yield* Effect.promise(
        (): Promise<{ readonly default: (pi: LoadedPi) => void }> =>
          import(`${context.dir}/pi-collie.ts`),
      );
      extension.default(refusingPi(registered, started));
      expect(Bun.env.COLLIE_CHAT_MCP_SERVERS).toBeUndefined();
      expect(registered[0]).toEqual([
        expect.stringMatching(/^cf-[0-9a-f]{32}$/),
        expect.objectContaining({ exposure: "direct" }),
      ]);
      expect(registered.slice(1)).toEqual([
        ["linear-server", piServers(configured).given["linear-server"]!],
        ["docs", piServers(configured).given["docs"]!],
      ]);
      const notices: string[] = [];
      for (const handler of started)
        handler({ type: "session_start" }, { ui: { notify: (message) => notices.push(message) } });
      expect(notices).toEqual([
        expect.stringContaining("refused: names registered by another extension throw"),
      ]);
    }),
  ));

test("a /mcp command goes to Pi as written, and what Pi says of it is the reply", () =>
  withPi((driver) =>
    Effect.gen(function* () {
      const turn = yield* opened(driver, "pi-command");
      const events = yield* turn("/mcp login linear-server");
      expect(replies(events)).toEqual(["Pi ran: /mcp login linear-server"]);
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    }),
  ));

test("what Pi reports during a model's turn comes with the next message's note, once", () =>
  withPi((driver) =>
    Effect.gen(function* () {
      const turn = yield* opened(driver, "pi-reported");
      expect(replies(yield* turn("Hi"))).toEqual(["Hello world !", "After agent_end"]);
      const next = inspectedOf(yield* turn("inspect")).prompt.message;
      expect(next).toContain("linear-server: needs sign-in, run /mcp login linear-server");
      expect(next).toContain("Here");
      const after = inspectedOf(yield* turn("inspect")).prompt.message;
      expect(after).not.toContain("needs sign-in");
    }),
  ));
