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
import { answerRead, checkLines, TOOLS, toolNamed } from "../src/tools";
import { herdLines } from "../src/toolkit";
import { boardLines, buildBoard } from "../src/board";
import { Flow, SECTIONS, sortBoard, recordIn } from "../src/board-model";
import { encodeVerifying, VERIFYING } from "../src/verify";
import { RunRecords } from "../src/run-records";
import { memoryWaitOf, waitForMemory } from "../src/memory-wait";
import { hostRecords, madeRun, recordsAt } from "./support/records";
import { task } from "./support/task";
import { runEffect } from "./support/effect";
import { epochMs } from "../src/time";
import { connect, frontDoor, socketOf } from "../src/host";
import { MODULES, hosted, hostedRun, settledRun } from "./support/hosted";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges } from "./support/forge";
import { readDispositions } from "../src/disposition";
import { until } from "./support/host";
import { collie, save } from "./support/world";
import { Rig } from "./support/recorder";
import { chatContextFor } from "../src/statusline";
import { takeShared } from "../src/config";
import { machineName } from "../src/peers";
import { sessionOptions } from "../desktop/src/bun/session";
import {
  editSettings,
  NO_FLOCK_SETTINGS,
  standingDirectionOf,
} from "../desktop/src/shared/flock-settings";

const encodeJson = flow(
  Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any)),
  Result.getOrThrow,
);

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

afterAll(() => {
  resetExecutors();
});

type Route =
  | { readonly route: "read"; readonly tool: string; readonly input?: JsonObject }
  | { readonly route: "propose"; readonly kind: ActionKind; readonly action: JsonObject }
  | { readonly route: "write"; readonly tool: string }
  | { readonly route: "offer"; readonly tool: string; readonly input: (run: string) => JsonObject }
  | { readonly route: "shell" };

const RUN = "r-does-not-exist";

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
  ["run start", { route: "write", tool: "collie_do" }],
  ["run list", { route: "read", tool: "collie_herd" }],
  ["run show", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run artefacts", { route: "read", tool: "collie_artefacts", input: { run: RUN } }],
  ["run artefact show", { route: "read", tool: "collie_artefacts", input: { run: RUN, id: "a1" } }],
  [
    "run artefact read",
    { route: "read", tool: "collie_artefacts", input: { run: RUN, id: "a1", revision: 1 } },
  ],
  [
    "run artefact refresh",
    { route: "read", tool: "collie_artefacts", input: { run: RUN, refresh: true } },
  ],
  [
    "artefacts",
    { route: "read", tool: "collie_artefacts", input: { query: "notes", unseen: true } },
  ],
  ["run artefact seen", { route: "write", tool: "collie_do" }],
  ["run artefact unseen", { route: "write", tool: "collie_do" }],
  ["run artefact register", { route: "write", tool: "collie_do" }],
  ["run wait", { route: "read", tool: "collie_run", input: { run: RUN } }],
  ["run stop", { route: "write", tool: "collie_do" }],
  ["run resume", { route: "write", tool: "collie_do" }],
  ["run publish", { route: "shell" }],
  ["run answer", { route: "write", tool: "collie_do" }],
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
  ["measure", { route: "shell" }],
  ["board", { route: "read", tool: "collie_herd" }],
  ["cleanup", { route: "read", tool: "collie_installation" }],
  ["cleanup --apply", { route: "propose", kind: "cleanup", action: { kind: "cleanup" } }],
  ["usage", { route: "shell" }],
  ["models", { route: "read", tool: "collie_models" }],
  ["connections", { route: "read", tool: "collie_connections" }],
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
  ...Arr.map(["pause", "resume", "remove"] as const, (change) => {
    const returned: readonly [string, Route] = [
      `schedule ${change}`,
      {
        route: "propose",
        kind: `schedule_${change}`,
        action: { kind: `schedule_${change}`, name: "daily" },
      },
    ];
    return returned;
  }),
  ["schedule move", { route: "shell" }],
  ["chat status", { route: "read", tool: "collie_installation" }],
  ["chat harness", { route: "shell" }],
  ["chat news", { route: "read", tool: "collie_news" }],
  ["chat status-line", { route: "shell" }],
  ["chat context", { route: "shell" }],
  ["chat heard", { route: "shell" }],
  ["tools list", { route: "shell" }],
  ["tools call", { route: "shell" }],
  ["mcp", { route: "shell" }],
  ["host", { route: "shell" }],
  ["host restart", { route: "shell" }],
  ["host rollback", { route: "shell" }],
  ["bridge", { route: "shell" }],
  ["machine list", { route: "shell" }],
  ["machine connect", { route: "shell" }],
  ["machine add", { route: "shell" }],
  ["machine forget", { route: "shell" }],
  ["machine invite", { route: "shell" }],
  ["upgrade", { route: "propose", kind: "upgrade", action: { kind: "upgrade" } }],
  ["onboard", { route: "propose", kind: "onboard", action: { kind: "onboard" } }],
  ["doctor", { route: "read", tool: "collie_installation" }],
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

type CommandNode = (typeof app.subcommands)[number]["commands"][number];

function leaves(node: CommandNode, path: ReadonlyArray<string> = []) {
  const here = [...path, node.name];
  const children = Arr.flatMap(node.subcommands ?? [], (group) => group.commands ?? []);
  if (children.length === 0) {
    const returned: string[] = [Arr.join(here.slice(1), " ")];
    return returned;
  }
  const returned: string[] = Arr.flatMap(children, (child) => leaves(child, here));
  return returned;
}

test("the operations are the command tree's, not a list somebody kept up to date", () => {
  const found = leaves(app);
  expect(found.length).toBeGreaterThan(40);
  expect(found).toContain("run stop");
  expect(found).toContain("run intent defaults show");
  const covered = new Set(Arr.map(INVENTORY, ([operation]) => operation));
  expect(Arr.filter(found, (leaf) => !covered.has(leaf))).toEqual([]);
});

test("every operation a human has, native chat has a route to", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-parity-" });
      const env = readEnv({ ...process.env, COLLIE_STATE_DIR: stateDir, PATH: "" });
      yield* registerRunExecutors();
      const carried = new Set(registeredKinds());
      const offered = encodeJson(toolNamed("collie_propose")!.input);

      for (const [operation, route] of INVENTORY) {
        if (route.route === "read") {
          const tool = toolNamed(route.tool);
          expect([operation, tool !== null]).toEqual([operation, true]);
          const answer = yield* tool!.call(env, route.input ?? {});
          expect([operation, answer.length > 0]).toEqual([operation, true]);
          expect([operation, pipe_(answer, Str.startsWith("Collie could not read that"))]).toEqual([
            operation,
            false,
          ]);
          continue;
        }
        if (route.route === "write") {
          const tool = toolNamed(route.tool);
          expect([operation, tool !== null]).toEqual([operation, true]);
          expect([operation, tool!.readOnly]).toEqual([operation, false]);
          continue;
        }
        if (route.route === "propose") {
          expect([operation, pipe_(offered, Str.includes(`"${route.kind}"`))]).toEqual([
            operation,
            true,
          ]);
          const decoded = decodeAction(route.action) satisfies Action;
          expect([operation, decoded.kind]).toEqual([operation, route.kind]);
          expect([operation, carried.has(route.kind)]).toEqual([operation, true]);
          continue;
        }
      }

      const kinds = Arr.flatMap(
        decodeOffered(toolNamed("collie_propose")!.input).properties.actions.items.anyOf,
        (one) => one.properties.kind.enum,
      );
      expect(kinds).toContain("start");
      for (const forbidden of ["confirm", "decline", "reconcile", "verify", "grant", "authorize"])
        expect([forbidden, kinds.includes(forbidden)]).toEqual([forbidden, false]);
      expect(registeredKinds()).not.toContain("confirm");
    }),
  ));

test("chat lists a finished Run's offers and takes one, as run actions and run action do", () =>
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
  ));

test("chat taking an offer whose work is still going gets the refusal run action gets", () =>
  hosted("hw-parity-twice-", ({ world, env }) =>
    Effect.gen(function* () {
      yield* save(world.user, ["delivers.workflow.ts", "ships.workflow.ts"]);
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const mr = "https://gitlab.cego.dk/cego/app/-/merge_requests/12";
      const { runId } = yield* client
        .start({ project: world.project, id: "delivers", request: "req-d", input: { mr } })
        .pipe(Effect.orDie);
      yield* until(
        () => client.run({ runId }).pipe(Effect.orDie),
        (view) => view?.status.status === "complete",
      );
      const first = yield* client
        .invoke({ runId, offer: "ship", input: {}, request: "ship-1" })
        .pipe(Effect.orDie);

      const typed = yield* collie(world, ["run", "action", runId, "ship"]);
      const refused = typed.envelope.error?.message ?? "run action started a second Ship";
      expect(refused).toContain(`is still going: ${first.runId}`);
      const chat = yield* toolNamed("collie_do")!.call(env, {
        actions: [{ kind: "take_offer", run: runId, offer: "ship" }],
      });
      expect(chat).toContain(refused);
    }),
  ));

test("nothing this build cannot carry out is offered as something to ask for", () =>
  runEffect(
    Effect.gen(function* () {
      yield* registerRunExecutors();
      const carried = new Set<string>(registeredKinds());
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
    task({
      id: "ready",
      name: "Shipping",
      state: "done",
      landed: false,
      shipping: "merge",
      shippingMr: "mr:gitlab.cego.dk/mk/collie!65",
      sentence: "Ready to release: mk/collie!65 is open.",
    }),
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
  expect(herdLines(views, 0)).toContain("Merge: Ready to release: mk/collie!65 is open.");
  expect(Arr.join(boardLines(views), "\n")).toContain(
    "Merge: Ready to release: mk/collie!65 is open.",
  );
});

test("chat's board read names the card's Offers, their owners and refusals", () => {
  const view = task({
    run: "r-fan",
    state: "done",
    landed: false,
    offers: [
      { id: "release", title: "Release api!7", run: "r-api" },
      {
        id: "stage",
        title: "Stage api!7",
        run: "r-api",
        unavailable: "a Stage is still going: r-stage",
      },
    ],
  });
  const said = herdLines([view], 0);
  expect(said).toContain("Release api!7 (release on run r-api)");
  expect(said).toContain("Stage api!7 (stage on run r-api): a Stage is still going: r-stage");
});

test("collie_run and collie_herd say what a running check's card says", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-parity-check-" });
      const run = yield* madeRun(stateDir, { id: "r-check" });
      const records = yield* RunRecords;
      const marker = encodeVerifying({
        name: "test",
        executable: "bun",
        argv: ["test"],
        pass: "recheck",
        round: null,
        revision: "abc",
        base: null,
        started: "2026-09-14T10:00:00Z",
      });
      yield* records.setControl(VERIFYING, run.id, marker);
      const now = epochMs("2026-09-14T10:12:00Z");
      const [card] = yield* buildBoard({
        env: readEnv({ COLLIE_STATE_DIR: stateDir, COLLIE_CWD: "/project" }),
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
      const other = yield* madeRun(stateDir, { id: "r-other-check" });
      yield* records.setControl(VERIFYING, other.id, marker);
      expect((yield* checkLines(run, [run], now, Effect.succeed([run, other])))[0]).toBe(
        `Check running: ${card!.sentence} 1 other check is running.`,
      );
    }),
  ));

test("a Run with no check answers without waiting for the other Runs a check is running for", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-check-answer-" });
      const run = yield* madeRun(stateDir, { id: "r-settled" });
      const other = yield* madeRun(stateDir, { id: "r-other" });
      yield* (yield* RunRecords).setControl(
        VERIFYING,
        other.id,
        encodeVerifying({
          name: "test",
          executable: "bun",
          argv: ["test"],
          pass: "gate",
          round: null,
          revision: "abc",
          base: null,
          started: "2026-09-14T10:00:00Z",
        }),
      );
      expect(
        yield* checkLines(run, [run, other], 0, Effect.never).pipe(Effect.timeout("2 seconds")),
      ).toEqual([]);
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
      yield* (yield* RunRecords).setControl(
        VERIFYING,
        run.id,
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
        COLLIE_STATE_DIR: stateDir,
        COLLIE_CWD: "/project",
        COLLIE_PROC: proc,
      });
      const waiting = yield* Effect.forkChild(
        waitForMemory({ env, stateDir, runId: run.id, what: "r-memory-build's launch" }),
      );
      while ((yield* memoryWaitOf(run.id)) === null) yield* Effect.sleep("10 millis");
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

test("collie_run carries the Flow Desktop draws for the Run, as run show does", () =>
  hosted("collie-parity-flow-", ({ world, env }) =>
    Effect.gen(function* () {
      const run = yield* hostedRun(world, "draw the work");
      const door = yield* frontDoor(socketOf(world.state));
      const detail = yield* until(
        () =>
          door
            .runDetail({ runId: run.id, tail: false, pages: 1, refreshMr: false })
            .pipe(Stream.map(recordIn), Stream.runHead, Effect.map(Option.getOrNull), Effect.orDie),
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
    }).pipe(Effect.provide(recordsAt(world.state))),
  ));

test("collie_run answers from related Runs without polling unrelated live executions", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-related-answer-" });
      const run = yield* madeRun(dir, { id: "r-parent", state: "succeeded" });
      const child = yield* madeRun(dir, { id: "r-child", parent: run.id });
      yield* Effect.provide(Effect.void, recordsAt(dir));
      const reads = {
        runs: Effect.die("unrelated live executions were polled"),
        related: Effect.succeed([run, child]),
        offers: () => Effect.succeed("Nothing is offered."),
        progress: () => Effect.succeed(null),
        flow: () => Effect.succeed(null),
        launches: () => Effect.succeed([]),
      };
      const answer = yield* answerRead(
        readEnv({ COLLIE_STATE_DIR: dir, COLLIE_CWD: "/project", PATH: "" }),
        "collie_run",
        { run: run.id },
        reads,
      );
      expect(answer).toContain("Status: succeeded");
      expect(answer).toContain("run r-child: implement, running");
    }),
  ));

test("a Machine's Native chat and Desktop's Flock chat are given the same Standing direction", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.scoped();
      const env = rig.pluginEnv();
      let flock = NO_FLOCK_SETTINGS;
      const flockChat = sessionOptions({
        cwd: "/state/collie-desktop",
        session: { resume: "5c1e6c8e-0000-4000-8000-000000000000" },
        model: "opus",
        effort: "medium",
        server: "the in-process server",
        claude: "/usr/local/bin/claude",
        userServers: {},
        ask: () => Promise.resolve({}),
        noticed: () => undefined,
        placement: () => undefined,
        standing: () => standingDirectionOf(flock),
      });
      const desktopContext = () =>
        Effect.promise(() => flockChat.hooks.UserPromptSubmit[0]!.hooks[0]!()).pipe(
          Effect.map((hook) => hook.hookSpecificOutput?.additionalContext ?? ""),
        );
      const edited = editSettings(
        flock,
        [{ key: "standing_direction", value: "Stage only; production waits for my go." }],
        "2026-10-02T09:30:00.000Z",
      );
      if ("refused" in edited) throw new Error(edited.refused);
      flock = edited;
      yield* takeShared(
        env.userDir,
        [{ key: "standing_direction", ...flock.settings["standing_direction"]! }],
        "desktop-1",
        "2026-10-02T09:31:00.000Z",
      );

      const native = yield* chatContextFor(env);
      expect(native).toContain("Stage only; production waits for my go.");
      expect(native).toContain("2026-10-02");
      expect(yield* desktopContext()).toContain(native);
    }).pipe(Effect.scoped),
  ));

test("chat's disposition is refused a superseded line naming its own Run, as the CLI's is", () =>
  hosted("collie-parity-self-", ({ world, env }) =>
    Effect.gen(function* () {
      const run = yield* settledRun(world, "retains");
      const said = yield* toolNamed("collie_do")!.call(env, {
        actions: [{ kind: "disposition", run: run.id, became: "superseded", ref: run.id }],
      });
      expect(said).toContain("disposition: failed");
      expect(said).toContain(`cannot name ${run.id}, the Run it is recorded on`);
      expect(yield* hostRecords(world.state, readDispositions(run.dir))).toEqual([]);
    }),
  ));

for (const answer of ["Keep F1 (no approval)", "Drop it (approve abc123)"])
  test(`chat answers the keep/drop Decision with ${answer}`, () =>
    hosted(
      "collie-parity-dispute-",
      ({ world, env }) =>
        Effect.gen(function* () {
          const { envelope } = yield* collie(world, [
            "run",
            "start",
            "follows-mr",
            "--input",
            "target=worktree",
            "--input",
            "proves=dispute",
          ]);
          expect(envelope).toMatchObject({ ok: true });
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(envelope.data).pipe(Effect.orDie);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const pending = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => (view?.waiting.length ?? 0) > 0,
          );
          expect(pending?.waiting[0]?.name).toBe("dispute-1");
          const said = yield* toolNamed("collie_do")!.call(env, {
            actions: [
              {
                kind: "answer",
                run: runId,
                choiceId: "dispute-1",
                answer,
              },
            ],
          });
          expect(said).toContain("answer: applied");
          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status.status === "complete" && done.status.value).toBe(answer);
        }),
      [...MODULES, "follows-mr.workflow.ts"],
    ));

test("chat starts a followed merge request as the Run the CLI started, and answers its approval", () =>
  hosted(
    "collie-parity-follow-",
    ({ world, env }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .writeFileString(`${world.config}/config.json`, `{"review": {"follow_through": true}}\n`)
          .pipe(Effect.orDie);
        const bin = yield* FakeBin.make(`${world.home}/bin`);
        const gitlab = yield* forgeOnPath(bin, "gitlab", {
          installed: true,
          loggedIn: ["gitlab.example.com"],
          login: "me",
          mrs: [
            {
              project: "gitlab.example.com/mk/project",
              iid: "7",
              state: "open",
              author: "ann",
              head: "1234567890abcdef1234567890abcdef12345678",
            },
          ],
        });
        const COLLIE_FORGE_API = yield* serveForges(gitlab);
        yield* bin.restore();
        const target = "https://gitlab.example.com/mk/project/-/merge_requests/7";
        const { envelope } = yield* collie(
          world,
          ["run", "start", "follows-mr", "--input", `target=${target}`, "--input", "proves=main"],
          { PATH: `${bin.dir}:${Bun.env.PATH}`, COLLIE_FORGE_API },
        );
        expect(envelope).toMatchObject({ ok: true });
        const { runId } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ runId: Schema.String }),
        )(envelope.data).pipe(Effect.orDie);

        const again = yield* toolNamed("collie_do")!.call(env, {
          actions: [
            {
              kind: "start",
              workflow: "follows-mr",
              workspace: world.project,
              inputs: { target, proves: "feature" },
            },
          ],
        });
        expect(again).toContain(`${runId} already follows gitlab.example.com/mk/project!7`);

        const client = yield* connect(world.state).pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => Arr.some(view?.waiting ?? [], (one) => one.name === "approve-1"),
        );
        const answered = yield* toolNamed("collie_do")!.call(env, {
          actions: [
            {
              kind: "answer",
              run: runId,
              choiceId: "approve-1",
              answer: "Approve",
            },
          ],
        });
        expect(answered).toContain("answer: applied");
        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status.status === "complete" && done.status.value).toBe("Approve");
      }),
    [...MODULES, "follows-mr.workflow.ts"],
  ));

test("a superseded line naming its own Run as <this machine>:<run> is refused as the bare id is", () =>
  hosted("collie-parity-self-qualified-", ({ world, env }) =>
    Effect.gen(function* () {
      const run = yield* settledRun(world, "retains");
      const said = yield* toolNamed("collie_do")!.call(env, {
        actions: [
          {
            kind: "disposition",
            run: run.id,
            became: "superseded",
            ref: `${machineName()}:${run.id}`,
          },
        ],
      });
      expect(said).toContain(`cannot name ${run.id}, the Run it is recorded on`);
      expect(yield* hostRecords(world.state, readDispositions(run.dir))).toEqual([]);
    }),
  ));
