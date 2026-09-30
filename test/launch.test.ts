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
import { herdOf } from "../src/steering";
import { stopHost } from "./support/host";
import { collie, proves, type World } from "./support/world";

const MODULES = ["targeted.workflow.ts", "planned.workflow.ts", "sourced.workflow.ts"];

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
  "words that are no plan directory or issue are the work source as text, and the Home refuses it for want of a checkout",
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

        const home = yield* atHome(world);
        const refused = answering(["sourced", "make the board faster"]);
        expect(yield* pickFlow(new Herdr(home), home, refused.prompts, "inline")).toBe(0);
        expect(refused.asked.at(-1)).toContain("needs a checkout");
        expect((yield* runViews(env, null)).runs).toHaveLength(1);
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
