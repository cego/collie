// The Flock chat runs on the user's own Claude Code with nothing of theirs loaded: no
// built-in tools, no settings, hooks, skills or CLAUDE.md, and Collie's tools as its only
// tools.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { sessionOptions } from "../desktop/src/bun/session";
import type { About } from "../desktop/src/shared/chat-view";

let about: About | undefined;
let noticed: string | undefined;
let rule: string | undefined;
const machines = [
  { name: "mk-pc", local: true },
  { name: "vm-mk", local: false },
];
const asked: string[] = [];
const options = sessionOptions({
  cwd: "/state/collie-desktop",
  session: { resume: "5c1e6c8e-0000-4000-8000-000000000000" },
  server: "the in-process server",
  claude: "/usr/local/bin/claude",
  ask: (toolUseID) => {
    asked.push(toolUseID);
    return Promise.resolve({ "Which one?": "vm-mk" });
  },
  about: () => about,
  noticed: () => noticed,
  placement: () => (rule === undefined ? undefined : { rule, machines }),
});
const permission = {
  signal: new AbortController().signal,
  toolUseID: "toolu_1",
};

test("the session is opus at medium effort, resumed, on the user's own Claude Code", () => {
  expect(options).toMatchObject({
    model: "opus",
    effort: "medium",
    resume: "5c1e6c8e-0000-4000-8000-000000000000",
    pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    cwd: "/state/collie-desktop",
  });
});

test("built-in tools are off but AskUserQuestion, no setting source is read, and Collie's server is the only one", () => {
  expect(options.tools).toEqual(["AskUserQuestion"]);
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  expect(Object.keys(options.mcpServers)).toEqual(["collie"]);
  expect(options.mcpServers.collie).toEqual({
    type: "sdk",
    name: "collie",
    instance: "the in-process server",
  });
  expect(options.allowedTools.every((name) => name.startsWith("mcp__collie__collie_"))).toBe(true);
  expect(options.allowedTools).toContain("mcp__collie__collie_do");
  expect(options.allowedTools).not.toContain("AskUserQuestion");
});

test("AskUserQuestion is put to the human, and goes on with their answers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const questions = [
        {
          question: "Which one?",
          header: "Machine",
          options: [],
          multiSelect: false,
        },
      ];
      const answer = yield* Effect.promise(() =>
        options.canUseTool("AskUserQuestion", { questions }, permission),
      );
      expect(asked).toEqual(["toolu_1"]);
      expect(answer).toEqual({
        behavior: "allow",
        updatedInput: { questions, answers: { "Which one?": "vm-mk" } },
      });
    }),
  ));

test("anything else that asks permission is refused", () =>
  Effect.runPromise(
    Effect.promise(() => options.canUseTool("Bash", {}, permission)).pipe(
      Effect.map((answer) => expect(answer).toMatchObject({ behavior: "deny" })),
    ),
  ));

const submitted = () => Effect.promise(() => options.hooks.UserPromptSubmit[0]!.hooks[0]!());

test("the card a message goes with is attached to it, as context and not as the human's words", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      about = undefined;
      expect(yield* submitted()).toEqual({});
      about = {
        machine: "vm-mk",
        task: "t-1",
        run: "r-2",
        name: "Fix board bugs",
      };
      const attached = yield* submitted();
      expect(attached.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
      expect(attached.hookSpecificOutput?.additionalContext).toContain("vm-mk:t-1");
      expect(attached.hookSpecificOutput?.additionalContext).toContain("vm-mk:r-2");
      expect(attached.hookSpecificOutput?.additionalContext).toContain("Fix board bugs");
    }),
  ));

test("News waiting for the human's next message goes with it, as context and not as their words", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      about = undefined;
      noticed = "- [routine] vm-mk:r-2: Run r-2 ended.";
      const attached = yield* submitted();
      expect(attached.hookSpecificOutput?.additionalContext).toContain("vm-mk:r-2: Run r-2 ended.");
      noticed = undefined;
    }),
  ));

test("a question in a turn nobody is watching is refused, so the turn ends rather than waits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const unwatched = sessionOptions({
        cwd: "/state/collie-desktop",
        session: { resume: "5c1e6c8e-0000-4000-8000-000000000000" },
        server: "the in-process server",
        claude: null,
        ask: () => Promise.resolve(null),
        about: () => undefined,
        noticed: () => undefined,
        placement: () => undefined,
      });
      const answer = yield* Effect.promise(() =>
        unwatched.canUseTool("AskUserQuestion", { questions: [] }, permission),
      );
      expect(answer).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("next message"),
      });
    }),
  ));

test("the Machine rule goes with every message, in the human's words, beside the Machines reachable now", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      about = undefined;
      rule = undefined;
      expect(yield* submitted()).toEqual({});
      rule = "Frontend work is on the laptop machine and everything else is on the vm";
      const first = (yield* submitted()).hookSpecificOutput?.additionalContext ?? "";
      expect(first).toContain(
        "The human's Machine rule, in their own words from Desktop's Settings:\nFrontend work is on the laptop machine and everything else is on the vm",
      );
      expect(first).toContain("mk-pc (this computer, where Desktop runs), vm-mk");
      // Edited between two turns, the second has the new words.
      rule = "Everything is on the vm";
      const second = (yield* submitted()).hookSpecificOutput?.additionalContext ?? "";
      expect(second).toContain("Everything is on the vm");
      expect(second).not.toContain("Frontend");
      rule = undefined;
    }),
  ));

test("the system prompt tells the chat to start where the rule says, and how to keep to it", () => {
  const prompt = options.systemPrompt.replace(/\s+/g, " ");
  expect(prompt).toContain("Machine rule: their own instruction");
  expect(prompt).toContain("name its Machine from the rule, unless the human's message names one");
  expect(prompt).toContain("not among those reachable, say so and start nothing elsewhere");
  expect(prompt).toContain("When the rule does not cover the work, ask");
});
