// Claude Code's own list of models, read through a short-lived Agent SDK query that starts no
// turn, and what of it the Flock chat offers.

import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import {
  type ModelRow,
  type ModelsQuery,
  readClaudeModels,
} from "../desktop/src/bun/claude-models";
import { harnessOffer } from "../desktop/src/shared/chat-choices";

const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Claude Code 2.1.308's list on 2026-10-22, with one id Collie's table refuses. */
const ROWS: ReadonlyArray<ModelRow> = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 5.5",
    supportsEffort: true,
    supportedEffortLevels: [...LEVELS],
  },
  {
    value: "opus",
    displayName: "Opus 5.5",
    description: "For complex work and everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: [...LEVELS],
  },
  {
    value: "sonnet",
    displayName: "Sonnet 5.5",
    description: "Most efficient for simpler tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
  {
    value: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest for quick answers",
    supportsEffort: false,
  },
  {
    value: "claude-opus-5",
    displayName: "Opus 5",
    description: "Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: [],
  },
  {
    value: "opus[1m]",
    displayName: "Opus 5.5 (1M context)",
    description: "For long sessions",
    supportsEffort: true,
    supportedEffortLevels: [...LEVELS],
  },
];

interface Asked {
  readonly options: unknown[];
  /** Whether the prompt had yielded a message by the time the list was asked for. */
  readonly yielded: boolean[];
  closed: number;
}

/** An Agent SDK query answering `supportedModels` with `rows`, or failing with `failure`. */
const fakeQuery =
  (asked: Asked, answer: () => Promise<ReadonlyArray<ModelRow>>): ModelsQuery =>
  ({ prompt, options }) => {
    asked.options.push(options);
    let yielded = false;
    void prompt[Symbol.asyncIterator]()
      .next()
      .then(() => {
        yielded = true;
      });
    return {
      supportedModels: () =>
        Promise.resolve().then(() => {
          asked.yielded.push(yielded);
          return answer();
        }),
      close: () => {
        asked.closed++;
      },
    };
  };

test("the list is read through a query that loads none of the human's setup, persists nothing and starts no turn, then closed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked = { options: [], yielded: [], closed: 0 };
      const listed = yield* readClaudeModels(
        fakeQuery(asked, () => Promise.resolve(ROWS)),
        "/usr/local/bin/claude",
      );
      expect(asked.options).toHaveLength(1);
      expect(asked.options[0]).toMatchObject({
        settingSources: [],
        tools: [],
        persistSession: false,
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      });
      expect(asked.options[0]).toHaveProperty("env.PATH");
      expect(asked.yielded).toEqual([false]);
      expect(asked.closed).toBe(1);

      const offer = harnessOffer("claude", listed, [], {});
      expect(offer.from).toBe("harness");
      expect(offer.models.map(({ id }) => id)).toEqual([
        "opus",
        "sonnet",
        "claude-haiku-4-5-20251001",
        "claude-opus-5",
      ]);
      expect(offer.models[0]).toEqual({
        id: "opus",
        label: "Opus 5.5",
        description: "For complex work and everyday tasks",
        efforts: [...LEVELS],
        unsetEffort: "medium",
      });
      expect(offer.models[1]!.efforts).toEqual(["low", "high"]);
      // Haiku 4.5 says it takes no effort; Opus 5 says it does but lists none.
      expect(offer.models[2]).toMatchObject({ label: "Haiku 4.5", efforts: [], unsetEffort: null });
      expect(offer.models[3]).toMatchObject({ efforts: [], unsetEffort: null });
      expect(offer.unset).toEqual({ harness: "claude", model: "opus", effort: "medium" });
      // An extra the Flock added is offered when Claude Code lists it.
      expect(harnessOffer("claude", listed, ["opus[1m]"], {}).models.map(({ id }) => id)).toContain(
        "opus[1m]",
      );
    }),
  ));

test("a list that cannot be read fails with why, and the query is closed all the same", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked = { options: [], yielded: [], closed: 0 };
      const read = yield* readClaudeModels(
        fakeQuery(asked, () => Promise.reject(new Error("Claude Code is not logged in"))),
        null,
      ).pipe(Effect.result);
      expect(read).toEqual(Result.fail("Claude Code is not logged in"));
      // With none on PATH, the SDK runs the Claude Code it carries.
      expect(asked.options[0]).toMatchObject({ pathToClaudeCodeExecutable: undefined });
      expect(asked.closed).toBe(1);
    }),
  ));
