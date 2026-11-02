// pi's question tool, which Collie's per-launch extension registers: loaded as pi loads it,
// called as pi calls it, and handing its questions to the real `collie` helper.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { piExtension, writeLaunchFiles } from "../src/chat";
import { controlDir } from "../src/compaction";
import { piQuestionTool, questionsSince } from "../src/compactors";
import { hostLockOf } from "../src/lock";
import { TOOLS } from "../src/tools";
import { runEffect } from "./support/effect";
import { askWith, piTools } from "./support/pi";

const SELF = [process.execPath, `${import.meta.dir}/../src/main.ts`];

const TWO = [
  {
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "the one ops runs" },
      { label: "SQLite", description: "a file beside the app" },
    ],
    multiSelect: false,
  },
  {
    question: "Which checks?",
    header: "Checks",
    options: [{ label: "lint", description: "oxlint" }],
    multiSelect: true,
  },
];

/** A Run agent's extension, written into `state`, with its question tool handing to `agent`'s control directory. */
const agentTools = Effect.fn("test.agentTools")(function* (state: string, agent: string) {
  const fs = yield* FileSystem.FileSystem;
  const control = yield* controlDir(state, agent);
  const file = `${state}/${agent}.tools.ts`;
  yield* fs.writeFileString(
    file,
    piExtension(SELF, [], {}, state, "news.jsonl", piQuestionTool(SELF, control)),
  );
  return { control, tools: yield* piTools(file) };
});

test(
  "pi's question tool hands both questions to the live host and tells the agent to end its turn",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pi-question-" });
        yield* fs.writeFileString(hostLockOf(state), `{"pid":${process.pid},"start":null}`);
        const { control, tools } = yield* agentTools(state, "builder");
        const told = yield* askWith(tools, "call_1", TWO, "pi-session-1");

        expect(yield* questionsSince(control, 0)).toEqual([
          { at: expect.any(Number), session: "pi-session-1", id: "call_1", questions: TWO },
        ]);
        expect(told).toContain("on your Run");
        expect(told).toContain("End your turn now");
        expect(told).toContain("your next message");
      }),
    ),
  30_000,
);

test(
  "with no live host, pi's question tool puts nothing on a Run and tells the agent to ask in its pane",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pi-question-" });
        const { control, tools } = yield* agentTools(state, "builder");
        const told = yield* askWith(tools, "call_1", TWO, "pi-session-1");

        expect(yield* questionsSince(control, 0)).toEqual([]);
        expect(told).not.toContain("End your turn");
        expect(told).toContain("in your pane");
      }),
    ),
  30_000,
);

test("chat's pi is given Collie's tools but no question tool: the human is already in its pane", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pi-chat-" });
      const files = yield* writeLaunchFiles({
        dir,
        pluginRoot: dir,
        userDir: dir,
        home: dir,
        self: SELF,
        serverEnv: { HERDR_PLUGIN_STATE_DIR: dir },
        news: `${dir}/news.jsonl`,
        tools: Arr.map(TOOLS, (tool) => ({
          name: tool.name,
          label: tool.title,
          description: tool.description,
          parameters: tool.input,
        })),
        mcpConfig: "{}",
      });
      const names = Arr.map(yield* piTools(files.extension), (tool) => tool.name);

      expect(names).toEqual(Arr.map(TOOLS, (tool) => tool.name));
      expect(names).not.toContain("ask_user_question");
    }),
  ));
