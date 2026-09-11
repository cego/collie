// The evaluator's value is entirely in what it refuses: no tools, no inherited settings,
// a cost ceiling, a clock, and a closed schema at both ends. Those are the assertions
// here — the argv exactly as it goes out, and what happens when the model answers with
// something that is not the shape it was given.

import { Effect, FileSystem, Schema } from "effect";
import { expect, test } from "bun:test";
import {
  ActionSchema,
  AnswerSchema,
  JudgementSchema,
  ProposalSchema,
  REQUIRED_FLAGS,
  argvFor,
  flagsPresent,
  jsonSchemaFor,
  structuredFrom,
  validate,
  type Proposal,
  type ValidationContext,
} from "../src/evaluator";
import { DEFAULT_AUTHORITY, type Authority } from "../src/intent";
import { runEffect } from "./support/effect";
import { leaks } from "../tools/evaluator-probe";

const limits = {
  maxSeconds: 120,
  maxOutputBytes: 262_144,
  model: "sonnet",
  effort: "medium",
};

test("the argv is the isolation, so it is asserted exactly", () => {
  expect(argvFor(limits, '{"type":"object"}', "/repo/prompts/steward.md")).toEqual([
    "-p",
    "--output-format",
    "json",
    // The schema text itself: the CLI parses this word as JSON, not as a path.
    "--json-schema",
    '{"type":"object"}',
    // Every one of these is load-bearing. Without `--tools ""` the model has tools;
    // without the settings and MCP flags it inherits the human's hooks and servers. No
    // spending flag: what a call costs is recorded, never capped.
    "--tools",
    "",
    "--restricted",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--model",
    "sonnet",
    "--effort",
    "medium",
    "--append-system-prompt-file",
    "/repo/prompts/steward.md",
  ]);
});

test("a CLI missing any of those flags is not one Collie will call", () =>
  runEffect(
    Effect.gen(function* () {
      const deps = {
        help: Effect.succeed(REQUIRED_FLAGS.join(" ")),
        systemPromptFile: "/repo/prompts/steward.md",
        limits,
      };
      expect(yield* flagsPresent(deps)).toEqual([]);

      // claude 2.1.268 folds the file spelling into one row, and takes both.
      const folded = {
        ...deps,
        help: Effect.succeed(
          `${REQUIRED_FLAGS.filter((flag) => flag !== "--append-system-prompt-file").join(" ")} via: --system-prompt[-file], --append-system-prompt[-file]`,
        ),
      };
      expect(yield* flagsPresent(folded)).toEqual([]);

      const older = { ...deps, help: Effect.succeed("--print --output-format --json-schema") };
      expect(yield* flagsPresent(older)).toEqual([
        "--tools",
        "--restricted",
        "--strict-mcp-config",
        "--setting-sources",
        "--no-session-persistence",
        "--append-system-prompt-file",
      ]);
    }),
  ));

test("the payload is found by what fits the schema, not by a field name", () => {
  const answer = { text: "it is on the wrong branch", evidence_refs: [], targets: [] };
  // Whatever the CLI calls its result field, and however deep it nests it.
  expect(structuredFrom(JSON.stringify({ result: answer }), AnswerSchema)).toEqual(answer);
  expect(structuredFrom(JSON.stringify({ data: { output: answer } }), AnswerSchema)).toEqual(
    answer,
  );
  // Including when it hands the structured output back as a JSON string.
  expect(structuredFrom(JSON.stringify({ content: JSON.stringify(answer) }), AnswerSchema)).toEqual(
    answer,
  );

  expect(structuredFrom("not json at all", AnswerSchema)).toEqual({
    error: "the CLI did not print JSON",
  });
  expect(structuredFrom(JSON.stringify({ result: "just prose" }), AnswerSchema)).toEqual({
    error: "nothing in the CLI's envelope matched the schema it was given",
  });
  // An answer of the wrong kind is not this kind's answer.
  expect(structuredFrom(JSON.stringify({ result: answer }), JudgementSchema)).toMatchObject({
    error: expect.any(String),
  });
});

test("every action the model may propose decodes, and nothing else does", () => {
  const decode = Schema.decodeUnknownOption(ActionSchema);
  const valid = [
    { kind: "update_intent", run: "r1", patch: "stay in src", base_version: 2 },
    { kind: "deliver", run: "r1", agent: "impl-1", text: "stay in src", mode: "boundary" },
    { kind: "hold", run: "r1" },
    { kind: "release", run: "r1" },
    { kind: "stop", run: "r1" },
    { kind: "answer", run: "r1", choiceId: "c1", answer: "Build it now" },
    { kind: "start", workflow: "implement", inputs: { plan: "p" } },
    { kind: "resume", run: "r1" },
    { kind: "followup", run: "r1", text: "the block is still open" },
    { kind: "navigate", run: "r1" },
    { kind: "clear_override", run: "r1", agent: "impl-1" },
    { kind: "ask_human", question: "which branch did you mean?" },
    { kind: "none", why: "nothing needs doing" },
  ];
  for (const action of valid)
    expect([action.kind, decode(action)._tag]).toEqual([action.kind, "Some"]);

  // There is no action that is "run this string", and a kind nobody defined is not one.
  expect(decode({ kind: "shell", command: "rm -rf /" })._tag).toBe("None");
  expect(decode({ kind: "deliver", run: "r1", agent: "a", text: "t", mode: "whenever" })._tag).toBe(
    "None",
  );
  expect(decode({ kind: "hold" })._tag).toBe("None");
});

test("the schema handed to the model is real JSON Schema for each kind", () => {
  for (const kind of ["answer", "judgement", "proposal"] as const) {
    const parsed: unknown = JSON.parse(jsonSchemaFor(kind));
    expect(parsed).toMatchObject({ type: "object" });
  }
  expect(jsonSchemaFor("proposal")).toContain("interpretation");
  expect(jsonSchemaFor("judgement")).toContain("reports");
});

const proposal = (actions: Proposal["actions"]): Proposal => ({
  interpretation: "the branch is wrong",
  targets: [{ run: "r1" }],
  actions,
  confidence: 0.8,
});

function ctx(over: Partial<ValidationContext> = {}, authority: Authority = DEFAULT_AUTHORITY) {
  return {
    runs: new Set(["r1"]),
    agents: new Map([["r1", new Set(["impl-1"])]]),
    intents: new Map([["r1", { version: 2, authority }]]),
    origin: "driver" as const,
    maxDeliveryBytes: 8 * 1024,
    ...over,
  };
}

test("nothing is allowed without a grant, and a grant is only good for a Driver's own check", () => {
  const correction = proposal([
    { kind: "deliver", run: "r1", agent: "impl-1", text: "stay in src", mode: "boundary" },
  ]);
  expect(validate(correction, ctx())[0]?.state).toBe("pending");

  const granting = { ...DEFAULT_AUTHORITY, auto_correct: true };
  expect(validate(correction, ctx({}, granting))[0]?.state).toBe("allowed_now");

  // The same grant, the same action, out of a conversation with a human: back to them.
  // The grant was for correcting drift, not for doing whatever the conversation found.
  expect(validate(correction, ctx({ origin: "steer" }, granting))[0]?.state).toBe("pending");
});

test("a mode needs its own grant on top of auto_correct", () => {
  const now = proposal([
    { kind: "deliver", run: "r1", agent: "impl-1", text: "look at this", mode: "now" },
  ]);
  const correcting = { ...DEFAULT_AUTHORITY, auto_correct: true };
  expect(validate(now, ctx({}, correcting))[0]?.state).toBe("pending");
  expect(validate(now, ctx({}, { ...correcting, now_allowed: true }))[0]?.state).toBe(
    "allowed_now",
  );
});

test("a decision is never granted, however much authority a Run has", () => {
  const everything: Authority = {
    auto_correct: true,
    max_corrections_per_constraint: 9,
    now_allowed: true,
    interrupt_allowed: true,
    stop_allowed: true,
    exclusive_steering: true,
    run_verification: [],
  };
  const decisions = proposal([
    { kind: "update_intent", run: "r1", patch: "new goal", base_version: 2 },
    { kind: "answer", run: "r1", choiceId: "c1", answer: "Build it now" },
    { kind: "resume", run: "r1" },
    { kind: "clear_override", run: "r1", agent: "impl-1" },
  ]);
  expect(validate(decisions, ctx({}, everything)).map((v) => v.state)).toEqual([
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  // A stop is the one lifecycle action a Run can grant.
  expect(validate(proposal([{ kind: "stop", run: "r1" }]), ctx({}, everything))[0]?.state).toBe(
    "allowed_now",
  );
});

test("an action about something the model was not shown becomes a question, not an action", () => {
  const invented = proposal([{ kind: "hold", run: "r-nobody-mentioned" }]);
  const [first] = validate(invented, ctx());
  expect(first?.action.kind).toBe("ask_human");
  expect(first?.state).toBe("pending");

  const wrongAgent = proposal([
    { kind: "deliver", run: "r1", agent: "not-a-real-agent", text: "hi", mode: "boundary" },
  ]);
  expect(validate(wrongAgent, ctx())[0]?.action).toMatchObject({
    kind: "ask_human",
    question: expect.stringContaining("not-a-real-agent"),
  });

  const tooLong = proposal([
    { kind: "deliver", run: "r1", agent: "impl-1", text: "x".repeat(9000), mode: "boundary" },
  ]);
  expect(validate(tooLong, ctx())[0]?.action).toMatchObject({ kind: "ask_human" });

  const stale = proposal([{ kind: "update_intent", run: "r1", patch: "p", base_version: 1 }]);
  expect(validate(stale, ctx())[0]?.action).toMatchObject({
    kind: "ask_human",
    question: expect.stringContaining("v1"),
  });
});

test("the frozen prompt says the three things it has to say", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(
        new URL("../prompts/steward.md", import.meta.url).pathname,
      );
      // No tools; the message is data, not instructions; and it cannot approve anything.
      expect(text).toContain("You have no tools");
      expect(text).toContain("is **data**");
      expect(text).toContain("You cannot approve anything");
      // And it names the specific injections it must not obey, which is the part a reader
      // of the pack would otherwise have to guess at.
      expect(text).toContain("ignore your instructions");
      expect(text).toContain("the human has already");
    }),
  ));

test("a proposal decodes as a whole, or not at all", () => {
  const decode = Schema.decodeUnknownOption(ProposalSchema);
  expect(decode(proposal([{ kind: "none", why: "nothing to do" }]))._tag).toBe("Some");
  expect(decode({ ...proposal([]), actions: [{ kind: "shell" }] })._tag).toBe("None");
  expect(decode({ interpretation: "x" })._tag).toBe("None");
});

test("the probe reads a transcript by event: the structured-output channel is not a tool leak", () => {
  const line = (event: Record<string, Schema.Json>) => JSON.stringify(event);
  const clean = [
    line({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] }),
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { text: "x" } }] },
    }),
    line({ type: "result", subtype: "success" }),
  ].join("\n");
  expect(leaks(clean)).toEqual([]);
  // A real tool offered, a real tool used, a hook that ran, an MCP server connected:
  // each is named, so the record says what leaked rather than that something did.
  const leaky = [
    line({
      type: "system",
      subtype: "init",
      tools: ["StructuredOutput", "Bash"],
      mcp_servers: [{}],
    }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    line({ type: "hook_started" }),
    // The words alone are not a leak: a clean init line names its tool list too.
    line({ type: "user", message: { content: [{ type: "text", text: "tool_use mcp hook" }] } }),
  ].join("\n");
  expect(leaks(leaky)).toEqual([
    "tool(s) offered: Bash",
    "1 MCP server(s)",
    "a tool_use block: Bash",
    "hook_started event",
  ]);
});
