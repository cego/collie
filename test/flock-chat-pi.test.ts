import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
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
      const driver = piDriver(context, endpoint, ["bun", `${import.meta.dir}/fixtures/pi-chat.ts`]);
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
        "builtin:mcp",
        "-e",
        `${context.dir}/pi-collie.ts`,
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--tools",
        expect.stringMatching(/^read,bash,edit,write,grep,find,ls,mcp__cf_[0-9a-f]{32}__\*$/),
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
      const prefix = pipe_(
        Str.split(details.args[details.args.indexOf("--tools") + 1]!, ",").at(-1)!,
        Str.slice(0, -1),
      );
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
              pi: piDriver(opened, endpoint, ["bun", `${import.meta.dir}/fixtures/pi-chat.ts`]),
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
              pi: piDriver(context, endpoint, ["bun", `${import.meta.dir}/fixtures/pi-chat.ts`]),
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
