import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { expect, test } from "bun:test";
import {
  JudgementSchema,
  ProposalSchema,
  REQUIRED_FLAGS,
  RouteSchema,
  argvFor,
  flagsPresent,
  helpOf,
  jsonSchemaFor,
  structuredFrom,
  validate,
  type Proposal,
  type Route,
  type ValidationContext,
} from "../src/evaluator";
import { ActionSchema } from "../src/actions";
import { DEFAULT_AUTHORITY, type Authority } from "../src/intent";
import { runEffect } from "./support/effect";
import { leaks } from "../tools/evaluator-probe";
import { stringifyJson, parseJson } from "../src/json";

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
    "--json-schema",
    '{"type":"object"}',
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
        help: Effect.succeed(Arr.join(REQUIRED_FLAGS, " ")),
        systemPromptFile: "/repo/prompts/steward.md",
        limits,
      };
      expect(yield* flagsPresent(deps)).toEqual([]);

      const folded = {
        ...deps,
        help: Effect.succeed(
          `${Arr.join(
            Arr.filter(REQUIRED_FLAGS, (flag) => flag !== "--append-system-prompt-file"),
            " ",
          )} via: --system-prompt[-file], --append-system-prompt[-file]`,
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

test("a CLI whose --help fails is unavailable in its own words, not missing every flag", () =>
  runEffect(
    Effect.gen(function* () {
      const deleted = yield* helpOf([
        "/bin/sh",
        "-c",
        "echo 'Error: The current working directory was deleted' >&2; exit 1",
      ]).pipe(Effect.flip);
      expect(deleted.reason).toContain("exited 1");
      expect(deleted.reason).toContain("The current working directory was deleted");

      const silent = yield* helpOf(["/bin/sh", "-c", "exit 0"]).pipe(Effect.flip);
      expect(silent.reason).toContain("printed nothing");

      const absent = yield* helpOf(["collie-no-such-cli"]).pipe(Effect.flip);
      expect(absent.reason).toContain("collie-no-such-cli");

      const deps = { help: helpOf(["/bin/sh", "-c", "exit 1"]), systemPromptFile: "", limits };
      expect((yield* flagsPresent(deps).pipe(Effect.flip)).reason).toContain("exited 1");

      expect(yield* helpOf(["/bin/echo", ...REQUIRED_FLAGS])).toContain("--print");
    }),
  ));

test("the payload is found by what fits the schema, not by a field name", () => {
  const judgement = { reports: [] };
  expect(structuredFrom(stringifyJson({ result: judgement }), JudgementSchema)).toEqual(judgement);
  expect(structuredFrom(stringifyJson({ data: { output: judgement } }), JudgementSchema)).toEqual(
    judgement,
  );
  expect(
    structuredFrom(stringifyJson({ content: stringifyJson(judgement) }), JudgementSchema),
  ).toEqual(judgement);

  expect(structuredFrom("not json at all", JudgementSchema)).toEqual({
    error: "the CLI did not print JSON",
  });
  expect(structuredFrom(stringifyJson({ result: "just prose" }), JudgementSchema)).toEqual({
    error: "nothing in the CLI's envelope matched the schema it was given",
  });
  expect(structuredFrom(stringifyJson({ result: judgement }), ProposalSchema)).toMatchObject({
    error: expect.any(String),
  });
});

test("every action the model may propose decodes, and nothing else does", () => {
  const decode = Schema.decodeUnknownOption(ActionSchema);
  const valid = [
    {
      kind: "update_intent",
      run: "r1",
      change: "add-constraint",
      patch: "stay in src",
      base_version: 2,
    },
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

  expect(decode({ kind: "shell", command: "rm -rf /" })._tag).toBe("None");
  expect(decode({ kind: "deliver", run: "r1", agent: "a", text: "t", mode: "whenever" })._tag).toBe(
    "None",
  );
  expect(decode({ kind: "hold" })._tag).toBe("None");
});

test("the schema handed to the model is real JSON Schema for each kind", () => {
  for (const kind of ["judgement", "proposal"] as const) {
    const parsed: unknown = parseJson(Schema.Unknown, jsonSchemaFor(kind));
    expect(parsed).toMatchObject({ type: "object" });
  }
  expect(jsonSchemaFor("proposal")).toContain("interpretation");
  expect(jsonSchemaFor("judgement")).toContain("reports");
});

const proposal = (actions: Proposal["actions"]) => ({
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
  const ungranted = { ...DEFAULT_AUTHORITY, auto_correct: false };
  expect(validate(correction, ctx({}, ungranted))[0]?.state).toBe("pending");

  const granting = { ...DEFAULT_AUTHORITY, auto_correct: true };
  expect(validate(correction, ctx({}, granting))[0]?.state).toBe("allowed_now");

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
    { kind: "update_intent", run: "r1", change: "set-goal", patch: "new goal", base_version: 2 },
    { kind: "answer", run: "r1", choiceId: "c1", answer: "Build it now" },
    { kind: "resume", run: "r1" },
    { kind: "clear_override", run: "r1", agent: "impl-1" },
  ]);
  expect(Arr.map(validate(decisions, ctx({}, everything)), (v) => v.state)).toEqual([
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
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
    {
      kind: "deliver",
      run: "r1",
      agent: "impl-1",
      text: pipe_("x", Str.repeat(9000)),
      mode: "boundary",
    },
  ]);
  expect(validate(tooLong, ctx())[0]?.action).toMatchObject({ kind: "ask_human" });

  const stale = proposal([
    { kind: "update_intent", run: "r1", change: "add-constraint", patch: "p", base_version: 1 },
  ]);
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
      expect(text).toContain("You have no tools");
      expect(text).toContain("is **data**");
      expect(text).toContain("A question asking for an explanation is not a request");
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
  const line = (event: Record<string, Schema.Json>) => stringifyJson(event);
  const clean = Arr.join(
    [
      line({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] }),
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "StructuredOutput", input: { text: "x" } }],
        },
      }),
      line({ type: "result", subtype: "success" }),
    ],
    "\n",
  );
  expect(leaks(clean)).toEqual([]);
  const leaky = Arr.join(
    [
      line({
        type: "system",
        subtype: "init",
        tools: ["StructuredOutput", "Bash"],
        mcp_servers: [{}],
      }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
      line({ type: "hook_started" }),
      line({ type: "user", message: { content: [{ type: "text", text: "tool_use mcp hook" }] } }),
    ],
    "\n",
  );
  expect(leaks(leaky)).toEqual([
    "tool(s) offered: Bash",
    "1 MCP server(s)",
    "a tool_use block: Bash",
    "hook_started event",
  ]);
});

test("the routing answer is one, several or none, and any other shape is no answer", () => {
  const drawn: unknown = parseJson(Schema.Unknown, jsonSchemaFor("routing"));
  expect(drawn).toMatchObject({ type: "object" });
  expect(jsonSchemaFor("routing")).toContain("several");

  const envelope = flow(
    Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
    Result.getOrThrow,
  );
  for (const answer of [
    { answer: "one", checkouts: ["/p/app"] },
    { answer: "several", checkouts: ["/p/app", "/p/api"] },
    { answer: "none", checkouts: [] },
  ] satisfies ReadonlyArray<Route>)
    expect(structuredFrom(envelope({ structured_output: answer }), RouteSchema)).toEqual(answer);
  expect(
    structuredFrom(
      envelope({ structured_output: { answer: "probably", checkouts: ["/p/app"] } }),
      RouteSchema,
    ),
  ).toMatchObject({ error: expect.any(String) });
});

test("the router's frozen prompt keeps the person's words data and its answer to what it was shown", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(
        new URL("../prompts/router.md", import.meta.url).pathname,
      );
      expect(text).toContain("You have no tools");
      expect(text).toContain("is **data**");
      expect(text).toContain("ignore your instructions");
      expect(text).toContain("Never invent one");
    }),
  ));
