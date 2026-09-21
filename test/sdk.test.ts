// The public workflow contract, held to what it promises an author.
//
// Everything here is about refusal before anything starts. A module that contradicts
// itself is caught at load, where nothing has been created yet, and the message names
// every conflict rather than the first — an author fixing one at a time learns the rules
// one round trip each.

import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import {
  EXCLUSIVE_STRATEGIES,
  RESERVED_INPUTS,
  WorkflowError,
  checkEntry,
  defineWorkflow,
  describeMetadata,
  jsonSchemaFor,
  type Registration,
  type WorkflowEntry,
  type WorkflowMetadata,
} from "../src/sdk";
import { REQUESTABLE, isOutcome, type Outcome } from "../src/outcome";

const requestable: ReadonlyArray<Outcome> = REQUESTABLE.filter(isOutcome);

/** Checking what a module declares never builds one, which is the point of doing it first. */
const registration = (): Registration => {
  throw new Error("checkEntry does not construct a registration");
};

const entry = (over: Partial<WorkflowEntry>): WorkflowEntry => ({
  id: "echo",
  title: "Echo",
  description: "Repeats a line.",
  input: { text: Schema.String },
  make: registration,
  ...over,
});

test("a module that says nothing wrong is registered", () => {
  expect(checkEntry(entry({}))).toEqual([]);
});

test("the identity is an identity, and the words a human reads are there", () => {
  expect(checkEntry(entry({ id: "Echo" }))[0]).toContain("is not an identity");
  expect(checkEntry(entry({ id: "2fast" }))[0]).toContain("is not an identity");
  expect(checkEntry(entry({ title: "  " }))).toEqual(["title is required"]);
  expect(checkEntry(entry({ description: "" }))).toEqual(["description is required"]);
});

test("an input may not take a name the host supplies at launch", () => {
  for (const reserved of Object.keys(RESERVED_INPUTS)) {
    const problems = checkEntry(entry({ input: { [reserved]: Schema.String } }));
    expect(problems.join("\n")).toContain(`input "${reserved}" collides with a host option`);
  }
});

test("only one input may claim each strategy inference reads", () => {
  for (const strategy of EXCLUSIVE_STRATEGIES) {
    const problems = checkEntry(
      entry({
        input: { here: Schema.String, there: Schema.String },
        metadata: { hints: { here: strategy, there: strategy } },
      }),
    );
    expect(problems).toEqual([`"here" and "there" both claim ${strategy}`]);
  }
  // Two fields may share a strategy nothing infers from.
  expect(
    checkEntry(
      entry({
        input: { here: Schema.String, there: Schema.String },
        metadata: { hints: { here: "optional", there: "optional" } },
      }),
    ),
  ).toEqual([]);
});

test("a hint names an input this workflow takes, and a strategy that exists", () => {
  expect(checkEntry(entry({ metadata: { hints: { nope: "optional" } } }))).toEqual([
    'hint for "nope", which is not an input',
  ]);
  expect(checkEntry(entry({ metadata: { hints: { text: "telepathy" } } })).join("\n")).toContain(
    'no strategy called "telepathy"',
  );
});

test("an outcome is fixed or selectable, and never contradicts itself", () => {
  expect(checkEntry(entry({ metadata: { outcome: { fixed: "review" } } }))).toEqual([]);
  expect(checkEntry(entry({ metadata: { outcome: { selectable: requestable } } }))).toEqual([]);
  expect(
    checkEntry(entry({ metadata: { outcome: { fixed: "feature", selectable: ["docs"] } } })),
  ).toEqual(["an outcome is either fixed or selectable, not both"]);
  expect(checkEntry(entry({ metadata: { outcome: { selectable: [] } } }))).toEqual([
    "a selectable outcome offers nothing",
  ]);
  // `review` and `plan` are what a workflow proves, never what a human asks an implement
  // Run for, so offering one as a choice is a contradiction too.
  expect(checkEntry(entry({ metadata: { outcome: { selectable: ["review"] } } }))[0]).toContain(
    "not an outcome a human may ask for",
  );
});

type Action = NonNullable<WorkflowMetadata["actions"]>[number];

const action = (over: Partial<Action>): Action => ({
  id: "fix-open",
  title: "Fix what is open",
  workflow: "implement",
  arguments: { plan: Schema.String },
  eligible: () => true,
  ...over,
});

test("an offer has a stable id, a title of its own, and a workflow it starts", () => {
  expect(checkEntry(entry({ metadata: { actions: [action({})] } }))).toEqual([]);
  expect(checkEntry(entry({ metadata: { actions: [action({ id: "Fix Open" })] } }))[0]).toContain(
    "is not an identity for an offer",
  );
  expect(checkEntry(entry({ metadata: { actions: [action({ title: " " })] } }))).toEqual([
    'offer "fix-open" has no title',
  ]);
  expect(
    checkEntry(entry({ metadata: { actions: [action({ workflow: "Not A Workflow" })] } }))[0],
  ).toContain("which is not a workflow id");
  // The id is what a card matches on, so two offers wearing one cannot be told apart.
  expect(
    checkEntry(
      entry({
        metadata: {
          actions: [action({})],
          followUps: [
            { id: "fix-open", title: "Also fix", workflow: "implement", when: "succeeded" },
          ],
        },
      }),
    ),
  ).toEqual(['two offers are called "fix-open"']);
});

test("every conflict is reported, not the first one", () => {
  const problems = checkEntry(
    entry({
      id: "Echo",
      input: { here: Schema.String, there: Schema.String, branch: Schema.String },
      metadata: {
        hints: { here: "work-source", there: "work-source" },
        actions: [action({ id: "Nope" })],
      },
    }),
  );
  expect(problems).toHaveLength(4);
});

test("the envelope is the host's runId and the author's input, keyed on the run", () => {
  const workflow = defineWorkflow({
    name: "echo@1",
    input: { text: Schema.String },
    success: Schema.String,
  });
  expect(workflow.idempotencyKey({ runId: "r1", input: { text: "hi" } })).toBe("r1");
  // Different input, same run: the same execution, which is what a retry has to be.
  expect(workflow.idempotencyKey({ runId: "r1", input: { text: "other" } })).toBe("r1");
  expect(Schema.decodeUnknownExit(workflow.payloadSchema)({ runId: "r1", input: {} })._tag).toBe(
    "Failure",
  );
  expect(workflow.errorSchema).toBe(WorkflowError);
});

test("a schema JSON Schema cannot say everything about is still a schema, and says so", () => {
  const drawable = jsonSchemaFor(Schema.Struct({ text: Schema.String }));
  expect(drawable.limits).toEqual([]);
  expect(drawable.document).not.toBeNull();

  // A declared schema draws as an empty object: valid JSON Schema that constrains
  // nothing. It still validates natively, which is the point — the limit is on the copy
  // a model would be held to, never on the contract.
  const url = Schema.declare((value: unknown): value is URL => value instanceof URL);
  const undrawable = Schema.Struct({ at: url });
  expect(Schema.decodeUnknownExit(undrawable)({ at: new URL("https://example/") })._tag).toBe(
    "Success",
  );
  expect(Schema.decodeUnknownExit(undrawable)({ at: "not a url" })._tag).toBe("Failure");
  const projected = jsonSchemaFor(undrawable);
  expect(projected.document).not.toBeNull();
  expect(projected.limits).toEqual(["properties.at projects to nothing"]);
});

test("what a card is given is ids, titles and projections — never the closures", () => {
  const described = describeMetadata({
    hints: { text: "work-source" },
    outcome: { selectable: ["feature"] },
    followUps: [{ id: "again", title: "Run again", workflow: "echo", when: "succeeded" }],
    actions: [action({})],
  });
  expect(described).toEqual({
    hints: { text: "work-source" },
    outcome: null,
    selectable: ["feature"],
    followUps: [{ id: "again", title: "Run again", workflow: "echo", when: "succeeded" }],
    actions: [
      {
        id: "fix-open",
        title: "Fix what is open",
        workflow: "implement",
        arguments: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
          additionalProperties: true,
          $defs: {},
        },
        limits: [],
      },
    ],
  });
  expect(JSON.stringify(described)).not.toContain("eligible");
});

test("a workflow's Layer is an ordinary Layer, which is what a module composes with", () => {
  const workflow = defineWorkflow({
    name: "probe@1",
    input: { text: Schema.String },
    success: Schema.String,
  });
  expect(Layer.isLayer(workflow.toLayer(() => Effect.succeed("x")))).toBe(true);
});
