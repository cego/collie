// The Launch flow as a human drives it (ADR-0033): which Workflow, then one question, then
// — only where something was inferred — one row saying where it starts and what it took.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, Scope } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { writeConfigValue } from "../src/config";
import { currentEnv, type PluginEnv } from "../src/env";
import { pickFlow, type FlowPrompts } from "../src/flows";
import { Herdr } from "../src/herdr";
import type { PickItem } from "../src/inputs";
import { homePath, writeHome } from "../src/home";
import { runViews } from "../src/lifecycle";
import { budgetPath, herdOf, readBudget } from "../src/steering";
import { stopHost } from "./support/host";
import { collie, proves, type World } from "./support/world";

const MODULES = [
  "targeted.workflow.ts",
  "planned.workflow.ts",
  "sourced.workflow.ts",
  "plan-stand-in.workflow.ts",
];

const QUESTION = "What do you want?";

/** Each menu and question in the order it came, and the rows each menu offered. */
const answering = (script: ReadonlyArray<string>) => {
  const answers = [...script];
  const asked: Array<string> = [];
  const rows: Array<PickItem> = [];
  const prompts: FlowPrompts = {
    menu: (items, options) => {
      asked.push(options.header);
      rows.push(...items);
      const wanted = answers.shift();
      return Effect.succeed(items.find((item) => item.id === wanted) ?? null);
    },
    ask: (question) => {
      asked.push(question);
      return Effect.succeed(answers.shift() ?? null);
    },
  };
  return { prompts, asked, rows };
};

const launching = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, BunServices | Scope.Scope>,
) => proves(prefix, (world) => body(world).pipe(Effect.ensuring(stopHost(world.state))), MODULES);

/** `glab` answering with this branch's open merge request, for the flow's own inference. */
const withMergeRequest = <A, E, R>(world: World, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bin = `${world.home}/bin`;
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(
      `${bin}/glab`,
      `#!/bin/sh\necho '{"iid": 42, "state": "opened", "title": "t"}'\n`,
      { mode: 0o755 },
    );
    // As `FakeBin` does, but over the real PATH: this world's Config has none to read.
    const path = Bun.env.PATH;
    Bun.env.PATH = `${bin}:${path ?? ""}`;
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          Bun.env.PATH = path;
        }),
      ),
    );
  });

const onBranch = (world: World, branch: string) => {
  for (const args of [
    ["checkout", "-q", "-b", branch],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"],
  ])
    Bun.spawnSync(["git", ...args], { cwd: world.project });
};

/** The flow opened from the Herd's Home, whose own directory is no checkout. */
const atHome = Effect.fn("test.atHome")(function* (world: World) {
  const env = yield* currentEnv;
  const socket = `${world.home}/herdr.sock`;
  const key = yield* herdOf(socket);
  yield* writeHome(yield* homePath(world.state, key), {
    workspaceId: "w-home",
    tabId: null,
    paneId: null,
    terminalId: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    token: "t",
    state: "ready",
    previous: [],
  });
  return { ...env, socketPath: socket, workspaceId: "w-home" } satisfies PluginEnv;
});

const Shown = Schema.Struct({
  data: Schema.Struct({
    run: Schema.Struct({ provenance: Schema.Record(Schema.String, Schema.String) }),
  }),
});

test(
  "what was inferred is shown before the start, and Esc starts nothing",
  () =>
    launching("collie-launch-inferred-", (world) =>
      withMergeRequest(
        world,
        Effect.gen(function* () {
          onBranch(world, "feature/x");
          const env = yield* currentEnv;

          const cancelled = answering(["targeted", ""]);
          expect(yield* pickFlow(new Herdr(env), env, cancelled.prompts, "inline")).toBe(0);
          expect(cancelled.asked).toHaveLength(3);
          expect((yield* runViews(env, null)).runs).toEqual([]);

          const { prompts, asked, rows } = answering(["targeted", "", "start"]);
          expect(yield* pickFlow(new Herdr(env), env, prompts, "inline")).toBe(0);
          expect(asked.slice(1)).toEqual([QUESTION, "A workflow pointed at a change"]);
          expect(rows.at(-1)).toEqual({
            id: "start",
            title: `Starting in ${world.project}`,
            subtitle: "target = mr:42 (inferred from branch feature/x's open merge request !42)",
          });

          const runs = (yield* runViews(env, null)).runs;
          expect(runs).toHaveLength(1);
          expect(runs[0]?.provenance).toEqual({ target: "inferred" });
          const shown = yield* collie(world, ["run", "show", runs[0]?.runId ?? ""]);
          const decoded = yield* Schema.decodeUnknownEffect(Shown)(shown.envelope);
          expect(decoded.data.run.provenance).toEqual({ target: "inferred" });
        }),
      ),
    ),
  240_000,
);

test(
  "a goal from a checkout is two questions and no confirmation, and is recorded as said",
  () =>
    launching("collie-launch-goal-", (world) =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        const { prompts, asked } = answering(["planned", "one registry"]);
        expect(yield* pickFlow(new Herdr(env), env, prompts, "inline")).toBe(0);
        expect(asked).toHaveLength(2);
        expect(asked[1]).toBe(QUESTION);
        const runs = (yield* runViews(env, null)).runs;
        expect(runs[0]).toMatchObject({
          cwd: world.project,
          input: { goal: "one registry" },
          provenance: { goal: "typed" },
          options: {},
        });
      }),
    ),
  240_000,
);

test(
  "no checkout is asked for from the Home: a goal starts at the Projects root",
  () =>
    launching("collie-launch-home-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = `${world.home}/projects`;
        yield* fs.makeDirectory(`${root}/app/.git`, { recursive: true });
        yield* writeConfigValue(world.config, "projects.root", root);
        const env = yield* atHome(world);

        const { prompts, asked } = answering(["planned", "one registry"]);
        expect(yield* pickFlow(new Herdr(env), env, prompts, "inline")).toBe(0);
        expect(asked.slice(1)).toEqual([QUESTION]);
        const runs = (yield* runViews(env, null)).runs;
        expect(runs[0]).toMatchObject({
          cwd: root,
          input: { goal: "one registry" },
          options: { workspace: "projects-root" },
        });
      }),
    ),
  240_000,
);

test(
  "words that are no plan directory or issue are the work source as text",
  () =>
    launching("collie-launch-source-", (world) =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        const here = answering(["sourced", "make the board faster"]);
        expect(yield* pickFlow(new Herdr(env), env, here.prompts, "inline")).toBe(0);
        expect(here.asked).toHaveLength(2);
        expect((yield* runViews(env, null)).runs[0]).toMatchObject({
          cwd: world.project,
          input: { plan: "make the board faster" },
        });
      }),
    ),
  240_000,
);

test(
  "a review with nothing to infer is refused with the reason, and nothing more is asked",
  () =>
    launching("collie-launch-refused-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const plain = `${world.home}/plain`;
        yield* fs.makeDirectory(plain, { recursive: true });
        const env = { ...(yield* currentEnv), cwd: plain };

        const { prompts, asked } = answering(["targeted", ""]);
        expect(yield* pickFlow(new Herdr(env), env, prompts, "inline")).toBe(0);
        expect(asked).toHaveLength(3);
        expect(asked[1]).toBe(QUESTION);
        expect(asked[2]).toContain(`targeted needs "target"`);
        expect(asked[2]).toContain(`nothing in ${plain} gave one`);
        expect((yield* runViews(env, null)).runs).toEqual([]);
      }),
    ),
  240_000,
);

/** Two checkouts under the Projects root, each pushing to a project of its own. */
const projectsTree = Effect.fn("test.projectsTree")(function* (world: World) {
  const root = `${world.home}/projects`;
  for (const name of ["app", "api"]) {
    const dir = `${root}/team/${name}`;
    Bun.spawnSync(["mkdir", "-p", dir]);
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync(["git", "remote", "add", "origin", `git@gitlab.example.com:team/${name}.git`], {
      cwd: dir,
    });
  }
  yield* writeConfigValue(world.config, "projects.root", root);
  // The router's frozen prompt, where an installation keeps it.
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${world.install}/prompts`, { recursive: true });
  yield* fs.copyFile(
    new URL("../prompts/router.md", import.meta.url).pathname,
    `${world.install}/prompts/router.md`,
  );
  return { root, app: `${root}/team/app`, api: `${root}/team/api` };
});

const FLAGS =
  "--print --output-format --json-schema --tools --restricted --strict-mcp-config --setting-sources --no-session-persistence --append-system-prompt-file";

/**
 * A `claude` on PATH that records each call's pack and answers `route`, or fails where
 * `route` is null — the evaluator the router asks, stood in at the process it runs.
 */
const withRouter = <A, E, R>(
  world: World,
  route: { answer: string; checkouts: ReadonlyArray<string> } | null,
  effect: (
    calls: Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bin = `${world.home}/router-bin`;
    const log = `${world.home}/router-calls`;
    yield* fs.makeDirectory(log, { recursive: true });
    const answer =
      route === null
        ? "exit 1"
        : `printf '%s' '${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ type: "result", structured_output: route })}'`;
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(
      `${bin}/claude`,
      `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "${FLAGS}"; exit 0; fi\ncat > "${log}/call-$$"\n${answer}\n`,
      { mode: 0o755 },
    );
    const calls = Effect.gen(function* () {
      const names = yield* fs.readDirectory(log).pipe(Effect.orElseSucceed(() => []));
      return yield* Effect.forEach(names, (name) =>
        fs.readFileString(`${log}/${name}`).pipe(Effect.orElseSucceed(() => "")),
      );
    });
    const path = Bun.env.PATH;
    Bun.env.PATH = `${bin}:${path ?? ""}`;
    return yield* effect(calls).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          Bun.env.PATH = path;
        }),
      ),
    );
  });

test(
  "from the Home, a merge request URL is placed in the checkout whose remote it names, with no model asked",
  () =>
    launching("collie-launch-url-", (world) =>
      Effect.gen(function* () {
        const tree = yield* projectsTree(world);
        const home = yield* atHome(world);
        yield* withRouter(world, { answer: "one", checkouts: [tree.api] }, (calls) =>
          Effect.gen(function* () {
            const url = "https://gitlab.example.com/team/app/-/merge_requests/42";
            const { prompts, rows } = answering(["targeted", url, "start"]);
            expect(yield* pickFlow(new Herdr(home), home, prompts, "inline")).toBe(0);
            expect(rows.at(-1)?.title).toBe(`Starting in ${tree.app}`);
            expect(yield* calls).toEqual([]);
            const run = (yield* runViews(home, null)).runs[0];
            expect(run).toMatchObject({
              cwd: tree.app,
              input: { target: expect.stringContaining("!42") },
              provenance: { workspace: "inferred", target: "typed" },
            });
          }),
        );
      }),
    ),
  240_000,
);

test(
  "a start from the Home is placed, never asked where: one routing call over every checkout, confirmed with Enter",
  () =>
    launching("collie-launch-routed-", (world) =>
      Effect.gen(function* () {
        const tree = yield* projectsTree(world);
        const home = yield* atHome(world);
        yield* withRouter(world, { answer: "one", checkouts: [tree.app] }, (calls) =>
          Effect.gen(function* () {
            const words = "make the app board faster";
            const cancelled = answering(["sourced", words, ""]);
            expect(yield* pickFlow(new Herdr(home), home, cancelled.prompts, "inline")).toBe(0);
            expect((yield* runViews(home, null)).runs).toEqual([]);

            const { prompts, asked, rows } = answering(["sourced", words, "start"]);
            expect(yield* pickFlow(new Herdr(home), home, prompts, "inline")).toBe(0);
            expect(asked.slice(1)).toEqual([QUESTION, "Build from a work source"]);
            expect(rows.at(-1)?.title).toBe(`Starting in ${tree.app}`);

            const packs = yield* calls;
            expect(packs).toHaveLength(2);
            for (const pack of packs) {
              expect(pack).toContain(words);
              expect(pack).toContain(tree.app);
              expect(pack).toContain(tree.api);
            }
            const run = (yield* runViews(home, null)).runs[0];
            expect(run).toMatchObject({
              cwd: tree.app,
              input: { plan: words },
              provenance: { workspace: "inferred", plan: "typed" },
            });

            const budget = yield* readBudget(
              yield* budgetPath(world.state, yield* herdOf(home.socketPath)),
            );
            const reserved = budget.filter((line) => line.kind === "reserve");
            expect(reserved).toHaveLength(2);
            for (const line of reserved)
              expect(line).toMatchObject({ model: "haiku", effort: "low" });
          }),
        );
      }),
    ),
  240_000,
);

for (const [what, route] of [
  ["several", { answer: "several", checkouts: ["/a", "/b"] }],
  ["none", { answer: "none", checkouts: [] }],
  ["an unavailable evaluator", null],
] as const) {
  test(
    `an answer of ${what} offers a plan at the Projects root instead`,
    () =>
      launching("collie-launch-instead-", (world) =>
        Effect.gen(function* () {
          const tree = yield* projectsTree(world);
          const home = yield* atHome(world);
          yield* withRouter(world, route, () =>
            Effect.gen(function* () {
              const words = "one registry for every service";
              const { prompts, rows } = answering(["sourced", words, "plan-instead"]);
              expect(yield* pickFlow(new Herdr(home), home, prompts, "inline")).toBe(0);
              expect(rows.at(-1)?.title).toBe("Plan it instead");
              const run = (yield* runViews(home, null)).runs[0];
              expect(run).toMatchObject({
                workflow: "plans-it",
                cwd: tree.root,
                input: { goal: words },
                options: { workspace: "projects-root" },
              });
            }),
          );
        }),
      ),
    240_000,
  );
}
