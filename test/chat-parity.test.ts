// Every human-facing Collie operation, and the conversational route that covers it.
//
// The promise this proves is "chat is not a reduced-control interface", and the way it
// fails silently is a list of hand-picked actions that looks complete. So the operations
// are not listed here at all: they are the CLI's own command tree, walked, plus the
// board's own commands and the flags that change what a command does. A command added
// upstream with no row here fails this file rather than passing unnoticed.
//
// Each row says what native chat does about it, and the three answers are deliberately
// different things:
//
//   read        — a tool answers it. The row carries the call, and it is made here.
//   write       — the human's own instruction, carried out at once by a tool of its own.
//                 Chat may do what the human could do on the board themselves; sending
//                 them to the UI for it is chat obstructing the person it serves.
//   propose     — something Collie wants of its own accord. The row carries the action,
//                 and it is decoded against the closed union and matched to a registered
//                 executor; the human confirms it on the board.
//   human-only  — the human's, and not chat's on purpose. Reconciling and granting
//                 authority are the human's own account of what happened and what work
//                 may do unasked; `verify` binds a command's exit to a tree, which is
//                 evidence, and evidence a model produced about itself is not. A yes to a
//                 proposal is not on this list: the human says it, and chat relays it.
//
// A leaf with no row is what this file exists to fail on.

import { Effect, FileSystem, Schema } from "effect";
import { afterAll, expect, test } from "bun:test";
import { app } from "../src/collie";
import { ActionSchema, type Action, type ActionKind } from "../src/evaluator";
import { registeredKinds, resetExecutors } from "../src/executors";
import { registerRunExecutors } from "../src/operations";
import { readEnv } from "../src/env";
import type { JsonObject } from "../src/schema";
import { TOOLS, toolNamed } from "../src/tools";
import { runEffect } from "./support/effect";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Any));
const decodeAction = Schema.decodeUnknownSync(ActionSchema);

// Registration is once per process and closes over the registering caller's state
// directory, so a file that registers has to put the registry back — otherwise the next
// file's confirmations run against this one's directory and change nothing it can see.
afterAll(() => {
  resetExecutors();
});

type Route =
  | { readonly route: "read"; readonly tool: string; readonly input?: JsonObject }
  | { readonly route: "propose"; readonly kind: ActionKind; readonly action: JsonObject }
  | { readonly route: "write"; readonly tool: string }
  | { readonly route: "human-only"; readonly why: string };

const RUN = "r-does-not-exist";

/** `collie <this>`, as the command tree spells it, and what chat does about it. */
const INVENTORY: ReadonlyArray<readonly [string, Route]> = [
  ["history list", { route: "read", tool: "collie_herd" }],
  [
    "history import",
    {
      route: "human-only",
      why: "reading what an older Collie left is something an installation does once, on its own; a conversation has nothing to decide about it",
    },
  ],
  ["workflow list", { route: "read", tool: "collie_definitions" }],
  ["workflow show", { route: "read", tool: "collie_definitions", input: { workflow: "review" } }],
  ["workflow check", { route: "read", tool: "collie_definitions", input: { workflow: "review" } }],
  [
    "workflow create",
    {
      route: "human-only",
      why: "a new module is source code somebody then writes; chat proposes the fork of one that already exists, and an agent with an editor writes the file itself",
    },
  ],
  [
    "workflow fork",
    {
      route: "propose",
      kind: "fork_definition",
      action: { kind: "fork_definition", what: "workflow", name: "review", as: "review-ours" },
    },
  ],
  ["persona list", { route: "read", tool: "collie_definitions" }],
  ["persona show", { route: "read", tool: "collie_definitions", input: { persona: "reviewer" } }],
  [
    "persona fork",
    {
      route: "propose",
      kind: "fork_definition",
      action: { kind: "fork_definition", what: "persona", name: "reviewer", as: "reviewer-ours" },
    },
  ],
  // Asked for by the human, carried out; wanted by Collie, proposed. `start` is in both
  // schemas for that reason, and the row names the human's side.
  ["run start", { route: "write", tool: "collie_do" }],
  ["run list", { route: "read", tool: "collie_herd" }],
  ["run show", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run wait", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run stop", { route: "write", tool: "collie_do" }],
  ["run resume", { route: "write", tool: "collie_do" }],
  ["run answer", { route: "write", tool: "collie_do" }],
  // The human's own instruction, carried out rather than proposed (ADR-0011). Stop,
  // resume, release, answer, steer and follow up are `collie_do`'s; a hold has a tool of
  // its own because it also holds a whole workspace, which no action kind does.
  ["run hold", { route: "write", tool: "collie_hold" }],
  ["run release", { route: "write", tool: "collie_do" }],
  [
    "run steer",
    {
      route: "human-only",
      why: "a human's own words, typed into the agent a workflow module's Run has; a model asking Collie to type into a pane is the boundary this file exists to hold",
    },
  ],
  [
    "run clear-override",
    {
      route: "propose",
      kind: "clear_override",
      action: { kind: "clear_override", run: RUN, agent: "a1" },
    },
  ],
  ["run deliveries", { route: "read", tool: "collie_receipts", input: { run: RUN } }],
  ["run disposition", { route: "write", tool: "collie_do" }],
  ["run metrics", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run drift", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run cards", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run actions", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run action", { route: "write", tool: "collie_do" }],
  ["run intent show", { route: "read", tool: "collie_run", input: { run: RUN } }],
  [
    "run intent set-goal",
    {
      route: "propose",
      kind: "update_intent",
      action: {
        kind: "update_intent",
        run: RUN,
        change: "set-goal",
        patch: "ship the parity gate",
        base_version: 1,
      },
    },
  ],
  [
    "run intent add-constraint",
    {
      route: "propose",
      kind: "update_intent",
      action: {
        kind: "update_intent",
        run: RUN,
        change: "add-constraint",
        patch: "stay in src",
        base_version: 1,
      },
    },
  ],
  [
    "run intent remove-constraint",
    {
      route: "propose",
      kind: "update_intent",
      action: {
        kind: "update_intent",
        run: RUN,
        change: "remove-constraint",
        patch: "c-stay-in-src",
        base_version: 1,
      },
    },
  ],
  [
    "run intent authority",
    {
      route: "human-only",
      why: "what a Run may do without asking is a grant, and a model that could widen its own is authorising itself",
    },
  ],
  [
    "run intent verification",
    {
      route: "human-only",
      why: "what counts as proof is the human's, for the same reason `verify` is",
    },
  ],
  ["run intent defaults show", { route: "read", tool: "collie_installation" }],
  [
    "run intent defaults add-constraint",
    {
      route: "propose",
      kind: "update_defaults",
      action: {
        kind: "update_defaults",
        change: "add-constraint",
        workspace: "w1",
        text: "no force pushes",
      },
    },
  ],
  [
    "run intent defaults remove-constraint",
    {
      route: "propose",
      kind: "update_defaults",
      // The id, not the prose: ids are a hash of the text, so a constraint named in words
      // matches nothing and removes nothing.
      action: {
        kind: "update_defaults",
        change: "remove-constraint",
        workspace: "w1",
        text: "3f2a91bc",
      },
    },
  ],
  [
    "run intent defaults set-authority",
    { route: "human-only", why: "the same grant, standing for every Run that follows" },
  ],
  ["task list", { route: "read", tool: "collie_workspaces" }],
  ["run output", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["steer", { route: "write", tool: "collie_do" }],
  ["confirm", { route: "write", tool: "collie_do" }],
  ["decline", { route: "write", tool: "collie_do" }],
  [
    "proposal reconcile",
    { route: "human-only", why: "only the person who watched it can say what happened" },
  ],
  [
    "verify",
    { route: "human-only", why: "evidence a model produced about its own work is not evidence" },
  ],
  // The same Herd, shaped as the board's Tasks rather than as its Runs.
  ["board", { route: "read", tool: "collie_herd" }],
  ["home show", { route: "read", tool: "collie_installation" }],
  [
    "home reconcile",
    {
      route: "human-only",
      why: "which workspace is the Herd's is exactly what Collie will not guess",
    },
  ],
  ["home cleanup", { route: "read", tool: "collie_installation" }],
  [
    "home cleanup --confirm",
    { route: "propose", kind: "home_cleanup", action: { kind: "home_cleanup" } },
  ],
  ["chat status", { route: "read", tool: "collie_installation" }],
  ["chat harness", { route: "human-only", why: "what Collie opens with is the human's setting" }],
  ["chat news", { route: "read", tool: "collie_news" }],
  // The line under the human's own prompt; `--install` is the setting behind it, which is
  // theirs like the harness preference is. Chat is told the same fact at each prompt.
  [
    "chat status-line",
    { route: "human-only", why: "the same fact reaches chat as prompt context" },
  ],
  [
    "chat context",
    { route: "human-only", why: "this is that context's own command: chat is given it" },
  ],
  [
    "tools list",
    { route: "human-only", why: "this is the conversational route itself: chat is given them" },
  ],
  ["tools call", { route: "human-only", why: "the same — this is how a tool call is made" }],
  ["mcp", { route: "human-only", why: "the same, for the harness that reaches Collie over MCP" }],
  [
    "host",
    {
      route: "human-only",
      why: "the process the work runs in, started for whoever needs one; not a thing to ask for",
    },
  ],
  ["upgrade", { route: "propose", kind: "upgrade", action: { kind: "upgrade" } }],
  ["doctor", { route: "read", tool: "collie_installation" }],
  // Not commands: the board's own operations, and the flags that change what a command
  // does rather than what it is about.
  [
    "board: focus an agent",
    {
      route: "propose",
      kind: "navigate",
      action: { kind: "navigate", run: RUN, agent: "a1" },
    },
  ],
  [
    "run deliveries --reconcile",
    { route: "human-only", why: "the human's, for a delivery nobody can account for" },
  ],
];

/** Any command in the tree, as the CLI itself types one. */
type CommandNode = (typeof app.subcommands)[number]["commands"][number];

/**
 * Every command a human can actually type, walked out of the command tree itself rather
 * than remembered. A group contributes its leaves and not itself: `collie run` alone is
 * a help page, and what a person runs is `collie run stop`.
 */
function leaves(node: CommandNode, path: ReadonlyArray<string> = []): string[] {
  const here = [...path, node.name];
  const children = (node.subcommands ?? []).flatMap((group) => group.commands ?? []);
  // The root's own name is not part of what a person types after `collie`.
  if (children.length === 0) return [here.slice(1).join(" ")];
  return children.flatMap((child) => leaves(child, here));
}

test("the operations are the command tree's, not a list somebody kept up to date", () => {
  const found = leaves(app);
  // The walk reaches the tree through Effect's own command shape, so a shape that
  // changed under it would quietly find nothing and pass everything.
  expect(found.length).toBeGreaterThan(40);
  expect(found).toContain("run stop");
  expect(found).toContain("run intent defaults show");
  const covered = new Set(INVENTORY.map(([operation]) => operation));
  expect(found.filter((leaf) => !covered.has(leaf))).toEqual([]);
});

test(
  "every operation a human has, native chat has a route to — or a reason it does not",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectory({ prefix: "hw-parity-" });
        const env = readEnv({ ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir });
        // The registry is filled by the module that owns each operation, so it has to be
        // asked rather than listed: a kind with no executor is refused at confirmation as
        // `executor_missing`, and a route to one would be control reduced to advice.
        yield* registerRunExecutors(env);
        const carried = new Set(registeredKinds());
        const offered = encodeJson(toolNamed("collie_propose")!.input);

        for (const [operation, route] of INVENTORY) {
          if (route.route === "read") {
            // Called, not looked up: a tool named in a table and never run is exactly the
            // completeness this file exists to stop claiming.
            const tool = toolNamed(route.tool);
            expect([operation, tool !== null]).toEqual([operation, true]);
            const answer = yield* tool!.call(env, route.input ?? {});
            expect([operation, answer.length > 0]).toEqual([operation, true]);
            expect([operation, answer.startsWith("Collie could not read that")]).toEqual([
              operation,
              false,
            ]);
            continue;
          }
          if (route.route === "write") {
            // A tool of its own, and one that admits it writes: a client decides from
            // `readOnly` what it may run without asking.
            const tool = toolNamed(route.tool);
            expect([operation, tool !== null]).toEqual([operation, true]);
            expect([operation, tool!.readOnly]).toEqual([operation, false]);
            continue;
          }
          if (route.route === "propose") {
            // Three halves, and each is a different way this goes wrong: a kind the model
            // is invited to ask for, an action the closed union actually accepts, and a
            // kind this build can carry out.
            expect([operation, offered.includes(`"${route.kind}"`)]).toEqual([operation, true]);
            const decoded = decodeAction(route.action) satisfies Action;
            expect([operation, decoded.kind]).toEqual([operation, route.kind]);
            expect([operation, carried.has(route.kind)]).toEqual([operation, true]);
            continue;
          }
          // And the human's stay the human's: a reason, and no tool that does it.
          expect([operation, route.why.length > 0]).toEqual([operation, true]);
        }
        yield* fs.remove(stateDir, { recursive: true, force: true });

        // The decisions, named: no action kind is any of these, so there is nothing for a
        // model to ask for that would settle one. This is the self-authorisation boundary.
        for (const forbidden of ["confirm", "decline", "reconcile", "verify", "grant", "authorize"])
          expect([
            forbidden,
            offered.includes(`"kind"`) && offered.includes(`"${forbidden}"`),
          ]).toEqual([forbidden, false]);
        expect(registeredKinds()).not.toContain("confirm");
      }),
    ),
  // `collie_installation` runs the installation checks, and one of them reaches a remote
  // with its own timeout. Calling the routes for real is the point of this test.
  120_000,
);

test("nothing this build cannot carry out is offered as something to ask for", () =>
  runEffect(
    Effect.gen(function* () {
      yield* registerRunExecutors(readEnv({ ...process.env }));
      const carried = new Set(registeredKinds());
      // `ask_human` and `none` are what the validator turns a refused action into, not
      // something to ask for; everything else the schema offers has to be runnable.
      const asked = INVENTORY.flatMap((entry) =>
        entry[1].route === "propose" ? [entry[1].kind] : [],
      );
      expect([...new Set(asked)].filter((kind) => !carried.has(kind))).toEqual([]);
    }),
  ));

test("every tool chat is given is a route somebody named", () => {
  // The other direction: a tool that no operation routes to is reach nobody asked for.
  const routed = new Set(
    INVENTORY.flatMap((entry) =>
      entry[1].route === "read" || entry[1].route === "write" ? [entry[1].tool] : [],
    ),
  );
  expect(TOOLS.map((tool) => tool.name).filter((name) => !routed.has(name))).toEqual([
    "collie_propose",
  ]);
});
