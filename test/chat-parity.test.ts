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

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Fiber, FileSystem, Option, Schema, Stream, flow, Result } from "effect";
import { hostname } from "node:os";
import { afterAll, expect, test } from "bun:test";
import { app } from "../src/collie";
import { ActionSchema, type Action, type ActionKind } from "../src/actions";
import { registeredKinds, resetExecutors } from "../src/executors";
import { registerRunExecutors } from "../src/operations";
import { readEnv } from "../src/env";
import type { JsonObject } from "../src/schema";
import { checkLines, TOOLS, toolNamed } from "../src/tools";
import { herdLines } from "../src/toolkit";
import { boardLines, buildBoard } from "../src/board";
import { Flow, SECTIONS, sortBoard } from "../src/board-model";
import { encodeVerifying } from "../src/verify";
import { memoryWaitOf, waitForMemory } from "../src/memory-wait";
import { madeRun } from "./support/records";
import { task } from "./support/task";
import { runEffect } from "./support/effect";
import { epochMs } from "../src/time";
import { connect, frontDoor, socketOf } from "../src/host";
import { hosted, hostedRun } from "./support/hosted";
import { until } from "./support/host";
import { save } from "./support/world";

const encodeJson = flow(
  Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any)),
  Result.getOrThrow,
);

/** A propose tool's input schema, as far as the action kinds it offers. */
const decodeOffered = flow(
  Schema.decodeUnknownResult(
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
  ),
  Result.getOrThrow,
);
const decodeAction = flow(Schema.decodeUnknownResult(ActionSchema), Result.getOrThrow);

// A file that registers its own executors leaves none for the next file.
afterAll(() => {
  resetExecutors();
});

type Route =
  | { readonly route: "read"; readonly tool: string; readonly input?: JsonObject }
  | { readonly route: "propose"; readonly kind: ActionKind; readonly action: JsonObject }
  | { readonly route: "write"; readonly tool: string }
  /** Called on a finished Run that offers `grade-it`, in a Herd with a host. */
  | { readonly route: "offer"; readonly tool: string; readonly input: (run: string) => JsonObject }
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
    "run withdraw-note",
    {
      route: "propose",
      kind: "withdraw_note",
      action: { kind: "withdraw_note", run: RUN, note: "n1" },
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
  ["run seen", { route: "write", tool: "collie_do" }],
  ["run metrics", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run checks", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run report", { route: "read", tool: "collie_report", input: { since: "2026-01-01" } }],
  ["run drift", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run cards", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run actions", { route: "offer", tool: "collie_run", input: (run) => ({ run }) }],
  [
    "run action",
    {
      route: "offer",
      tool: "collie_do",
      input: (run) => ({
        actions: [
          {
            kind: "take_offer",
            run,
            offer: "grade-it",
            inputs: { note: "the diff", grade: "pass" },
          },
        ],
      }),
    },
  ],
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
    "run intent set-outcome",
    {
      route: "propose",
      kind: "update_intent",
      action: {
        kind: "update_intent",
        run: RUN,
        change: "set-outcome",
        patch: "feature",
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
  ["settings list", { route: "shell" }],
  ["settings set", { route: "shell" }],
  ["run output", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["steer", { route: "write", tool: "collie_do" }],
  ["confirm", { route: "write", tool: "collie_do" }],
  ["decline", { route: "write", tool: "collie_do" }],
  ["proposal reconcile", { route: "shell" }],
  ["verify", { route: "shell" }],
  // Chat runs `collie measure` as the human types it, through the same host operation.
  ["measure", { route: "shell" }],
  // The same Herd, shaped as the board's Tasks rather than as its Runs.
  ["board", { route: "read", tool: "collie_herd" }],
  ["home show", { route: "read", tool: "collie_installation" }],
  ["home reconcile", { route: "shell" }],
  ["home cleanup", { route: "read", tool: "collie_installation" }],
  [
    "home cleanup --confirm",
    { route: "propose", kind: "home_cleanup", action: { kind: "home_cleanup" } },
  ],
  ["cleanup", { route: "read", tool: "collie_installation" }],
  ["cleanup --apply", { route: "propose", kind: "cleanup", action: { kind: "cleanup" } }],
  ["usage", { route: "shell" }],
  [
    "schedule add",
    {
      route: "propose",
      kind: "schedule_add",
      action: {
        kind: "schedule_add",
        name: "daily",
        cron: "0 7 * * *",
        start: { workflow: "review", inputs: {} },
      },
    },
  ],
  ["schedule list", { route: "read", tool: "collie_installation" }],
  ...Arr.map(["pause", "resume", "remove"] as const, (change): readonly [string, Route] => [
    `schedule ${change}`,
    {
      route: "propose",
      kind: `schedule_${change}`,
      action: { kind: `schedule_${change}`, name: "daily" },
    },
  ]),
  ["schedule move", { route: "shell" }],
  ["chat status", { route: "read", tool: "collie_installation" }],
  ["chat harness", { route: "shell" }],
  ["chat news", { route: "read", tool: "collie_news" }],
  // The line under the human's own prompt; chat is told the same fact at each prompt.
  ["chat status-line", { route: "shell" }],
  ["chat context", { route: "shell" }],
  ["chat heard", { route: "shell" }],
  ["tools list", { route: "shell" }],
  ["tools call", { route: "shell" }],
  ["mcp", { route: "shell" }],
  ["host", { route: "shell" }],
  ["host restart", { route: "shell" }],
  ["bridge", { route: "shell" }],
  ["machine list", { route: "shell" }],
  ["machine connect", { route: "shell" }],
  ["machine invite", { route: "shell" }],
  ["upgrade", { route: "propose", kind: "upgrade", action: { kind: "upgrade" } }],
  ["onboard", { route: "propose", kind: "onboard", action: { kind: "onboard" } }],
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
  [
    "run hold --before",
    { route: "propose", kind: "hold", action: { kind: "hold", run: RUN, before: "review" } },
  ],
  [
    "run release --before",
    { route: "propose", kind: "release", action: { kind: "release", run: RUN, before: "review" } },
  ],
  [
    "run steer --step",
    {
      route: "propose",
      kind: "deliver",
      action: { kind: "deliver", run: RUN, step: "review", text: "Check ordering" },
    },
  ],
  [
    "run steer --to",
    {
      route: "propose",
      kind: "deliver",
      action: { kind: "deliver", run: RUN, to: "builder", text: "keep going" },
    },
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
  const children = Arr.flatMap(node.subcommands ?? [], (group) => group.commands ?? []);
  // The root's own name is not part of what a person types after `collie`.
  if (children.length === 0) return [Arr.join(here.slice(1), " ")];
  return Arr.flatMap(children, (child) => leaves(child, here));
}

test("the operations are the command tree's, not a list somebody kept up to date", () => {
  const found = leaves(app);
  // The walk reaches the tree through Effect's own command shape, so a shape that
  // changed under it would quietly find nothing and pass everything.
  expect(found.length).toBeGreaterThan(40);
  expect(found).toContain("run stop");
  expect(found).toContain("run intent defaults show");
  const covered = new Set(Arr.map(INVENTORY, ([operation]) => operation));
  expect(Arr.filter(found, (leaf) => !covered.has(leaf))).toEqual([]);
});

test(
  "every operation a human has, native chat has a route to",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-parity-" });
        // An empty PATH: the installation checks would otherwise run the operator's own
        // claude, glab and gh, each allowed twenty seconds to answer, on every call below.
        const env = readEnv({ ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir, PATH: "" });
        // The registry is filled by the module that owns each operation, so it has to be
        // asked rather than listed: a kind with no executor is refused at confirmation as
        // `executor_missing`, and a route to one would be control reduced to advice.
        yield* registerRunExecutors();
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
            expect([
              operation,
              pipe_(answer, Str.startsWith("Collie could not read that")),
            ]).toEqual([operation, false]);
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
            expect([operation, pipe_(offered, Str.includes(`"${route.kind}"`))]).toEqual([
              operation,
              true,
            ]);
            const decoded = decodeAction(route.action) satisfies Action;
            expect([operation, decoded.kind]).toEqual([operation, route.kind]);
            expect([operation, carried.has(route.kind)]).toEqual([operation, true]);
            continue;
          }
          // offer: called in the next test, on a Run that has one.
          // shell: the leaf is the command tree's own, which the first test holds.
        }

        // The decisions, named: no action kind is any of these, so a proposal can never
        // carry its own yes. Settling one is a separate act — the human's or chat's.
        const kinds = Arr.flatMap(
          decodeOffered(toolNamed("collie_propose")!.input).properties.actions.items.anyOf,
          (one) => one.properties.kind.enum,
        );
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

test(
  "chat lists a finished Run's offers and takes one, as run actions and run action do",
  () =>
    hosted("hw-parity-offer-", ({ world, env }) =>
      Effect.gen(function* () {
        yield* save(world.user, [
          "offered.workflow.ts",
          "graded.workflow.ts",
          "capability.ts",
          "house.ts",
        ]);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const { runId } = yield* client
          .start({
            project: world.project,
            id: "offered",
            request: "req-offered",
            input: { note: "the diff" },
            task: "task-offering",
          })
          .pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        const said = (operation: string) => {
          const route = Option.getOrUndefined(
            Arr.findFirst(INVENTORY, ([one]) => one === operation),
          )?.[1];
          if (route?.route !== "offer") throw new Error(`${operation} is not an offer row`);
          return toolNamed(route.tool)!.call(env, route.input(runId));
        };

        expect(yield* said("run actions")).toContain("grade-it  Grade what this found (graded)");

        const taken = yield* said("run action");
        expect(taken).toContain("take_offer: applied");
        const child = yield* client
          .run({ runId: /Started run (\S+) from/.exec(taken)?.[1] ?? "" })
          .pipe(Effect.orDie);
        expect(child?.parent).toBe(runId);
        expect(child?.task).toBe("task-offering");
      }),
    ),
  // A host, and a Run of it that finishes, then one it starts.
  60_000,
);

test("nothing this build cannot carry out is offered as something to ask for", () =>
  runEffect(
    Effect.gen(function* () {
      yield* registerRunExecutors();
      const carried = new Set<string>(registeredKinds());
      // `ask_human` and `none` are what the validator turns a refused action into, not
      // something to ask for; everything else the schema offers has to be runnable.
      const offered = Arr.flatMap(
        decodeOffered(toolNamed("collie_propose")!.input).properties.actions.items.anyOf,
        (one) => one.properties.kind.enum,
      );
      expect(
        Arr.filter(
          offered,
          (kind) => kind !== "ask_human" && kind !== "none" && !carried.has(kind),
        ),
      ).toEqual([]);
    }),
  ));

test("every tool chat is given is a route somebody named", () => {
  // The other direction: a tool that no operation routes to is reach nobody asked for.
  const routed = new Set(
    Arr.flatMap(INVENTORY, (entry) =>
      entry[1].route === "shell" || entry[1].route === "propose" ? [] : [entry[1].tool],
    ),
  );
  expect(
    Arr.filter(
      Arr.map(TOOLS, (tool) => tool.name),
      (name) => !routed.has(name),
    ),
  ).toEqual(["collie_propose"]);
});

test("chat and the text board list the sections in the board's one order", () => {
  const views = sortBoard([
    task({ id: "done", name: "Landed", state: "done" }),
    task({ id: "working", name: "Building" }),
    task({ id: "waiting", name: "Shippable", state: "done", landed: false }),
    task({ id: "blocked", name: "Asking", state: "blocked" }),
  ]);
  const order = Arr.map(SECTIONS, ([, title]) => title);
  const titled = (lines: ReadonlyArray<string>) =>
    Arr.flatMap(lines, (line) =>
      Arr.filter(order, (title) => pipe_(line, Str.replace(/^## /, ""), Str.startsWith(title))),
    );
  expect(titled(Str.split(herdLines(views, 0), "\n"))).toEqual(order);
  expect(titled(boardLines(views))).toEqual(order);
});

test("collie_run and collie_herd say what a running check's card says", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-parity-check-" });
      const run = yield* madeRun(stateDir, { id: "r-check" });
      yield* fs.writeFileString(
        `${run.dir}/verifying`,
        encodeVerifying({
          name: "test",
          executable: "bun",
          argv: ["test"],
          pass: "recheck",
          round: null,
          revision: "abc",
          base: null,
          started: "2026-09-14T10:00:00Z",
        }),
      );
      const now = epochMs("2026-09-14T10:12:00Z");
      const [card] = yield* buildBoard({
        env: readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" }),
        runs: [run],
        tasks: [],
        registered: [],
        proposals: [],
        mrStates: new Map(),
        now,
      });
      expect(card!.sentence).toBe(
        "Running test again on the same tree to rule out a flake, 12 min.",
      );
      expect((yield* checkLines(run, [run], now))[0]).toBe(`Check running: ${card!.sentence}`);
      expect(herdLines([card!], now)).toContain(card!.sentence);
    }),
  ));

test("collie_run gives a running check's last forty lines under the card's sentence", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-parity-lines-" });
      const run = yield* madeRun(stateDir, { id: "r-lines" });
      const log = `${run.evidence}/checks/test.log`;
      yield* fs.makeDirectory(`${run.evidence}/checks`, { recursive: true });
      yield* fs.writeFileString(
        log,
        Arr.join(
          Array.from({ length: 45 }, (_, at) => `line ${at + 1}`),
          "\n",
        ) + "\n",
      );
      yield* fs.writeFileString(
        `${run.dir}/verifying`,
        encodeVerifying({
          name: "test",
          executable: "bun",
          argv: ["test"],
          pass: "gate",
          round: null,
          revision: "abc",
          base: null,
          started: "2026-09-14T10:00:00Z",
          log,
        }),
      );
      const lines = yield* checkLines(run, [run], epochMs("2026-09-14T10:04:00Z"));
      expect(lines.slice(0, 2)).toEqual([
        "Check running: Running test on the branch, 4 min.",
        "Its last lines:",
      ]);
      expect(lines.slice(2)).toEqual(Array.from({ length: 40 }, (_, at) => `  line ${at + 6}`));
    }),
  ));

test("the card, collie_run and collie_herd say the same of a Run waiting for memory", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-parity-memory-" });
      const run = yield* madeRun(stateDir, { id: "r-memory" });
      const proc = `${stateDir}/proc`;
      yield* fs.makeDirectory(proc);
      yield* fs.writeFileString(
        `${proc}/meminfo`,
        `MemTotal: ${62 * 1048576} kB\nMemAvailable: ${2 * 1048576} kB\n`,
      );
      const env = readEnv({
        HERDR_PLUGIN_STATE_DIR: stateDir,
        COLLIE_CWD: "/project",
        COLLIE_PROC: proc,
      });
      const waiting = yield* Effect.forkChild(
        waitForMemory({ env, stateDir, runId: run.id, what: "r-memory-build's launch" }),
      );
      while ((yield* memoryWaitOf(run.dir)) === null) yield* Effect.sleep("10 millis");
      const now = epochMs("2026-09-14T10:12:00Z");
      const [card] = yield* buildBoard({
        env,
        runs: [run],
        tasks: [],
        registered: [],
        proposals: [],
        mrStates: new Map(),
        now,
      });
      expect(card!.sentence).toBe(`Waiting for memory on ${hostname()}: 2.0 of 62.0 GB available.`);
      expect(yield* checkLines(run, [run], now)).toEqual([card!.sentence]);
      expect(herdLines([card!], now)).toContain(card!.sentence);
      yield* Fiber.interrupt(waiting);
    }),
  ));

test(
  "collie_run carries the Flow Desktop draws for the Run, as run show does",
  () =>
    hosted("collie-parity-flow-", ({ world, env }) =>
      Effect.gen(function* () {
        const run = yield* hostedRun(world, "draw the work");
        const door = yield* frontDoor(socketOf(world.state));
        // Its question is asked a moment before the engine records the Run suspended.
        const detail = yield* until(
          () =>
            door
              .runDetail({ runId: run.id, tail: false, pages: 1, refreshMr: false })
              .pipe(Stream.runHead, Effect.map(Option.getOrNull), Effect.orDie),
          (shown) => shown?.flow?.lanes[0]?.execution === "suspended",
        );
        const said = yield* toolNamed("collie_run")!.call(env, { run: run.id });
        const block = /### Flow, as `run show --json` carries it\n\n```json\n(.*)\n```/s.exec(said);
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Flow))(block?.[1] ?? "").pipe(
            Effect.orDie,
          ),
        ).toEqual(detail!.flow!);
        expect(Arr.map(detail!.flow!.lanes, (lane) => lane.run)).toEqual([run.id]);
      }),
    ),
  // A host, and a Run of it waiting on its decision.
  60_000,
);
