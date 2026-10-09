import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Crypto, Effect, FileSystem, Path, Schema, Scope, Stream } from "effect";
import { piDriver } from "../desktop/src/bun/pi-driver";
import { loopbackTools } from "../desktop/src/bun/chat-endpoint";
import type { DriverContext } from "../desktop/src/bun/driver";
import { openFlockChat } from "../desktop/src/bun/chat";
import { aboutNote } from "../desktop/src/shared/chat-view";
import { FLOCK_TOOLS } from "../desktop/src/bun/flock-tools";
import { FILE_TOOLS } from "../desktop/src/bun/file-tools";
import { piPrompt } from "../desktop/src/bun/pi-transcript";
import { ends } from "../desktop/src/shared/agui";
import { childEnv } from "../desktop/src/bun/login-env";

const withPi = <A, E>(
  body: (
    driver: ReturnType<typeof piDriver>,
    context: DriverContext,
  ) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "flock-pi-" });
      const env = childEnv();
      const previous = env.PI_CODING_AGENT_DIR;
      env.PI_CODING_AGENT_DIR = `${dir}/agent`;
      yield* fs.makeDirectory(env.PI_CODING_AGENT_DIR);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete env.PI_CODING_AGENT_DIR;
          else env.PI_CODING_AGENT_DIR = previous;
        }),
      );
      const services = yield* Effect.context<Crypto.Crypto | FileSystem.FileSystem>();
      const context: DriverContext = {
        dir,
        run: (effect) => Effect.runPromise(effect.pipe(Effect.provideContext(services))),
        flock: {
          machines: () => [],
          conversation: "flock@test",
          said: () => "Hi",
          attachments: () => undefined,
          uploaded: new Map(),
          machineRule: () => "",
          setMachineRule: () => Effect.void,
          inSync: () => Effect.succeed(""),
          chatHarness: () => ({ harness: "pi", model: undefined, runsOn: null }),
          setChatHarness: () => Effect.succeed(null),
        },
        ask: () => Promise.resolve(null),
        noticed: () => "A Run ended",
        placement: () => ({ rule: "Here", machines: [] }),
      };
      const endpoint = yield* loopbackTools(context);
      const driver = piDriver(context, endpoint, ["bun", `${import.meta.dir}/fixtures/pi-chat.ts`]);
      return yield* body(driver, context);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
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
      expect(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT")).toMatchObject([
        { delta: "Hello\u2028world\u2029!" },
        { delta: "After agent_end" },
      ]);
      expect(events.filter((event) => event.type === "REASONING_MESSAGE_CONTENT")).toMatchObject([
        { delta: "Considering" },
      ]);
      expect(events.filter((event) => event.type === "TOOL_CALL_START")).toMatchObject([
        { toolCallId: "herd", toolCallName: "mcp__collie__collie_herd" },
      ]);
      expect(events.filter((event) => event.type === "TOOL_CALL_RESULT")).toMatchObject([
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
      const text = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT");
      if (text?.type !== "TEXT_MESSAGE_CONTENT") throw new Error("No reply");
      const details = Schema.decodeUnknownSync(
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
      )(text.delta);
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
      const prefix = details.args[details.args.indexOf("--tools") + 1]!.split(",")
        .at(-1)!
        .slice(0, -1);
      for (const name of [...FLOCK_TOOLS, ...FILE_TOOLS, { name: "AskUserQuestion" }].map(
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

test("resetting Pi's model resumes the conversation on its configured default and thinking level", () =>
  withPi((driver) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const settings = `${childEnv().PI_CODING_AGENT_DIR}/settings.json`;
      yield* fs.writeFileString(
        settings,
        Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
          defaultProvider: "openai-codex",
          defaultModel: "gpt-6.1-sol",
          defaultThinkingLevel: "high",
        }),
      );
      const first = yield* driver.open("pi-reset", "openai-codex/gpt-5.3-codex-spark", "low");
      yield* Effect.addFinalizer(() => first.close);
      const inspect = (session: typeof first) =>
        session.offer("inspect").pipe(
          Effect.andThen(Stream.runCollect(session.events.pipe(Stream.takeUntil(ends)))),
          Effect.map((events) => {
            const text = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT");
            if (text?.type !== "TEXT_MESSAGE_CONTENT") throw new Error("No reply");
            return Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Struct({
                  model: Schema.String,
                  thinking: Schema.String,
                }),
              ),
            )(text.delta);
          }),
        );
      expect(yield* inspect(first)).toEqual({
        model: "openai-codex/gpt-5.3-codex-spark",
        thinking: "low",
      });
      yield* first.close;
      yield* fs.writeFileString(
        settings,
        Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
          defaultProvider: "openai-codex",
          defaultModel: "gpt-5.6-terra",
          defaultThinkingLevel: "xhigh",
        }),
      );
      const reset = yield* driver.open("pi-reset", "default", "");
      yield* Effect.addFinalizer(() => reset.close);
      expect(reset.conversation()).toBe("pi-reset");
      expect(yield* inspect(reset)).toEqual({
        model: "openai-codex/gpt-5.6-terra",
        thinking: "xhigh",
      });
      yield* reset.close;
      yield* fs.writeFileString(
        settings,
        Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
          defaultProvider: "openai-codex",
          defaultModel: "gpt-5.6-terra",
          defaultThinkingLevel: "low",
          modelThinkingLevels: { "openai-codex/gpt-5.6-terra": "max" },
        }),
      );
      const perModel = yield* driver.open("pi-reset", "default", "");
      yield* Effect.addFinalizer(() => perModel.close);
      expect(yield* inspect(perModel)).toEqual({
        model: "openai-codex/gpt-5.6-terra",
        thinking: "max",
      });
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
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
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
        choice: () => ({ ok: true, choice: { harness: "pi", model: "default", effort: null } }),
        chatHarness: () => ({ harness: "pi", model: undefined }),
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
      expect(events.find((event) => event.type === "TOOL_CALL_START")).toMatchObject({
        toolCallName: "AskUserQuestion",
      });
      expect(events.find((event) => event.type === "TOOL_CALL_RESULT")).toMatchObject({
        content: expect.stringContaining("Here"),
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));
