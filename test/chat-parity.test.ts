// Every human-facing Collie operation, and the conversational route that covers it.
//
// The promise this proves is "chat is not a reduced-control interface", and the way it
// fails silently is a list of hand-picked actions that looks complete. So the operations
// are not listed here at all: they are the CLI's own command tree, walked, plus the
// board's own commands and the flags that change what a command does. A command added
// upstream with no row here fails this file rather than passing unnoticed.
//
// Each row says how native chat does it, and every operation has one — anything a human
// can do, an agent can do (AGENTS.md, invariant 1):
//
//   read        — a tool answers it. The row carries the call, and it is made here.
//   write       — carried out at once by a tool of its own. Sending the human to the UI
//                 for something chat can plainly do is chat obstructing the person it
//                 serves.
//   propose     — carried out by collie_propose in the same call, with no yes. The row
//                 carries the action, and it is decoded against the closed union and
//                 matched to a registered executor.
//   shell       — chat runs the command itself, as the human types it: the same
//                 validation and the same executors, so a tool of its own would only
//                 restate it.
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

/** A propose tool's input schema, as far as the action kinds it offers. */
const decodeOffered = Schema.decodeUnknownSync(
  Schema.Struct({
    properties: Schema.Struct({
      actions: Schema.Struct({
        items: Schema.Struct({
          anyOf: Schema.Array(
            Schema.Struct({
              properties: Schema.Struct({
                kind: Schema.Struct({ enum: Schema.Array(Schema.String) }),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
);
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
  | { readonly route: "shell" };

const RUN = "r-does-not-exist";

/** `collie <this>`, as the command tree spells it, and what chat does about it. */
const INVENTORY: ReadonlyArray<readonly [string, Route]> = [
  ["workflow list", { route: "read", tool: "collie_definitions" }],
  ["workflow show", { route: "read", tool: "collie_definitions", input: { workflow: "review" } }],
  ["workflow check", { route: "read", tool: "collie_definitions", input: { workflow: "review" } }],
  ["workflow create", { route: "shell" }],
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
  ["run steer", { route: "shell" }],
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
  ["run report", { route: "read", tool: "collie_herd" }],
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
  ["run intent authority", { route: "shell" }],
  [
    "run intent verification",
    {
      route: "propose",
      kind: "set_verification",
      action: {
        kind: "set_verification",
        run: RUN,
        name: "unit",
        command: { executable: "bun", argv: ["test"], cwd: "worktree" },
      },
    },
  ],
  [
    "run intent remember",
    {
      route: "propose",
      kind: "remember_verification",
      action: { kind: "remember_verification", run: RUN, replace: true },
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
  ["run intent defaults set-authority", { route: "shell" }],
  ["task list", { route: "read", tool: "collie_workspaces" }],
  ["run output", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["steer", { route: "write", tool: "collie_do" }],
  ["confirm", { route: "write", tool: "collie_do" }],
  ["decline", { route: "write", tool: "collie_do" }],
  ["proposal reconcile", { route: "shell" }],
  ["verify", { route: "shell" }],
  // The same Herd, shaped as the board's Tasks rather than as its Runs.
  ["board", { route: "read", tool: "collie_herd" }],
  ["home show", { route: "read", tool: "collie_installation" }],
  ["home reconcile", { route: "shell" }],
  ["home cleanup", { route: "read", tool: "collie_installation" }],
  [
    "home cleanup --confirm",
    { route: "propose", kind: "home_cleanup", action: { kind: "home_cleanup" } },
  ],
  ["chat status", { route: "read", tool: "collie_installation" }],
  ["chat harness", { route: "shell" }],
  ["chat news", { route: "read", tool: "collie_news" }],
  // The line under the human's own prompt; chat is told the same fact at each prompt.
  ["chat status-line", { route: "shell" }],
  ["chat context", { route: "shell" }],
  ["tools list", { route: "shell" }],
  ["tools call", { route: "shell" }],
  ["mcp", { route: "shell" }],
  ["host", { route: "shell" }],
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
  ["run deliveries --reconcile", { route: "shell" }],
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
  "every operation a human has, native chat has a route to",
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
          // shell: the leaf is the command tree's own, which the first test holds.
        }
        yield* fs.remove(stateDir, { recursive: true, force: true });

        // The decisions, named: no action kind is any of these, so a proposal can never
        // carry its own yes. Settling one is a separate act — the human's or chat's.
        const kinds = decodeOffered(
          toolNamed("collie_propose")!.input,
        ).properties.actions.items.anyOf.flatMap((one) => one.properties.kind.enum);
        expect(kinds).toContain("start");
        for (const forbidden of ["confirm", "decline", "reconcile", "verify", "grant", "authorize"])
          expect([forbidden, kinds.includes(forbidden)]).toEqual([forbidden, false]);
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
