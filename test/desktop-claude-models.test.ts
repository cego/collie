import { expect, test } from "bun:test";
import { Effect } from "effect";
import { readClaudeModels, type ModelQuery } from "../desktop/src/bun/claude-models";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";

test("Claude Code's catalogue is read without a turn or setup, filtered, and closed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let closed = 0;
      let yielded = false;
      const query: ModelQuery = ({ prompt, options }) => {
        expect(options).toMatchObject({
          cwd: "/state/desktop",
          settingSources: [],
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          pathToClaudeCodeExecutable: "/login/bin/claude",
        });
        expect(options.env.PATH).toBeString();
        expect(options).not.toHaveProperty("resume");
        expect(options).not.toHaveProperty("sessionId");
        void prompt[Symbol.asyncIterator]()
          .next()
          .then((result) => {
            if (!result.done) yielded = true;
          });
        return {
          supportedModels: () =>
            Promise.resolve([
              { value: "default", displayName: "Default", description: "Native default" },
              {
                value: "opus",
                displayName: "Opus 5",
                description: "Complex work",
                supportsEffort: true,
                supportedEffortLevels: ["low", "medium", "high", "max"],
              },
              {
                value: "claude-haiku-4-5-20251001",
                displayName: "Haiku 4.5",
                description: "Quick tasks",
                supportsEffort: false,
                supportedEffortLevels: ["high"],
              },
              {
                value: "sonnet",
                displayName: "Sonnet 5",
                description: "Coding",
                supportsEffort: true,
              },
              { value: "not-accepted", displayName: "Unknown", description: "Refused id" },
            ]),
          close: () => {
            closed++;
          },
        };
      };
      const models = yield* readClaudeModels(
        query,
        NO_FLOCK_SETTINGS,
        "/state/desktop",
        "/login/bin/claude",
      );
      expect(models).toEqual([
        {
          id: "opus",
          label: "Opus 5",
          description: "Complex work",
          efforts: ["low", "medium", "high", "max"],
        },
        {
          id: "claude-haiku-4-5-20251001",
          label: "Haiku 4.5",
          description: "Quick tasks",
          efforts: [],
        },
        { id: "sonnet", label: "Sonnet 5", description: "Coding", efforts: [] },
      ]);
      expect(yielded).toBe(false);
      expect(closed).toBe(1);
    }),
  ));
