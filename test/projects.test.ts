// The Projects root and the checkouts under it: where a Run started from the Home is
// rooted, and the one listing the router and an agent's refusal choose from.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { runOnPath } from "./support/forge";
import { workspaceNamed } from "../src/operations";
import { exec } from "./support/command";
import { collie, proves } from "./support/world";
import { stopHost } from "./support/host";
import { FakeBin } from "./support/bin";
import { startCheckout } from "../src/agent-start";
import { checkoutFor } from "../src/worktree";
import { Rig, FakeHerdr } from "./support/recorder";
import { writeConfigValue } from "../src/config";
import { checkoutsUnder, projectsRoot } from "../src/projects";

let rig: Rig;

beforeEach(() =>
  runOnPath(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runOnPath(rig.close()));

test("projects.root in the config wins, and says it came from there", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* writeConfigValue(rig.userDir, "projects.root", "/work/mine");
      const env = rig.pluginEnv({ GITTE_CWD: "/work/gitte" });

      expect(yield* projectsRoot(env)).toEqual({ path: "/work/mine", source: "config" });
    }),
  ));

test("without a configured root, gitte's folder is the root", () =>
  runOnPath(
    Effect.gen(function* () {
      const env = rig.pluginEnv({ GITTE_CWD: "/work/gitte" });

      expect(yield* projectsRoot(env)).toEqual({ path: "/work/gitte", source: "gitte" });
    }),
  ));

test("with neither, the human's home is the root", () =>
  runOnPath(
    Effect.gen(function* () {
      const env = rig.pluginEnv();

      expect(yield* projectsRoot(env)).toEqual({ path: rig.root, source: "home" });
    }),
  ));

test("the checkouts are the real ones, never a worktree, a hidden one or a dependency's", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = `${rig.root}/projects`;
      const dirs = [
        "shallow/.git",
        "shallow/vendor/inner/.git",
        "a/b/c/deep/.git",
        "a/b/c/deep/sub/.git",
        "a/b/c/d/e/too-deep/.git",
        ".hidden/repo/.git",
        "web/node_modules/dep/.git",
      ];
      for (const dir of dirs) yield* fs.makeDirectory(`${root}/${dir}`, { recursive: true });
      yield* fs.makeDirectory(`${root}/worktree`, { recursive: true });
      yield* fs.writeFileString(`${root}/worktree/.git`, "gitdir: /elsewhere/.git/worktrees/w\n");

      expect(yield* checkoutsUnder(root)).toEqual([`${root}/a/b/c/deep`, `${root}/shallow`]);
    }),
  ));

test(
  "a repository URL or owner/name finds this Machine's origin or upstream checkout",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* exec(["git", "init", "-q"], { cwd: rig.projectDir });
        yield* exec(["git", "remote", "add", "origin", "git@github.com:cego/collie.git"], {
          cwd: rig.projectDir,
        });
        yield* writeConfigValue(rig.userDir, "projects.root", rig.root);
        for (const named of [
          "cego/collie",
          "https://github.com/cego/collie",
          "git@github.com:cego/collie.git",
        ])
          expect(yield* workspaceNamed(rig.pluginEnv(), named)).toMatchObject({
            found: { cwd: rig.projectDir },
          });
        yield* exec(["git", "remote", "set-url", "origin", "git@github.com:mk/fork.git"], {
          cwd: rig.projectDir,
        });
        yield* exec(["git", "remote", "add", "upstream", "https://github.com/cego/collie.git"], {
          cwd: rig.projectDir,
        });
        expect(yield* workspaceNamed(rig.pluginEnv(), "cego/collie")).toMatchObject({
          found: { cwd: rig.projectDir },
        });
        expect(yield* workspaceNamed(rig.pluginEnv(), "cego/missing")).toMatchObject({
          error: expect.stringContaining(rig.root),
        });
        expect(yield* workspaceNamed(rig.pluginEnv(), "cego/missing")).toMatchObject({
          error: expect.stringContaining("cego/missing"),
        });
      }),
    ),
  120_000,
);

test(
  "relative and home directory starts keep their existing path meaning",
  () =>
    proves(
      "collie-path-start-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.symlink(world.project, `${world.home}/repo`);
          for (const workspace of ["../project", "./", "~/repo"]) {
            const reply = yield* collie(world, [
              "tools",
              "call",
              "collie_do",
              "--input",
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                actions: [
                  { kind: "start", workflow: "plain", workspace, inputs: { note: "hello" } },
                ],
              }).pipe(Effect.orDie),
            ]);
            expect(reply.envelope.ok).toBe(true);
            expect(reply.envelope.data).toMatchObject({
              text: expect.stringContaining("start: applied"),
            });
          }
          yield* stopHost(world.state);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "interleaved remote branch fetches place each checkout on its own fetched commit",
  () =>
    runOnPath(
      Effect.gen(function* () {
        const remote = `${rig.root}/remote.git`;
        yield* exec(["git", "init", "--bare", "-q", remote]);
        yield* exec(["git", "init", "-q", "-b", "master"], { cwd: rig.projectDir });
        yield* exec(
          [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-qm",
            "base",
            "--allow-empty",
          ],
          { cwd: rig.projectDir },
        );
        yield* exec(["git", "remote", "add", "origin", remote], { cwd: rig.projectDir });
        const heads: string[] = [];
        for (const branch of ["first-topic", "second-topic"]) {
          yield* exec(["git", "switch", "-qc", branch], { cwd: rig.projectDir });
          yield* exec(
            [
              "git",
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.test",
              "commit",
              "-qm",
              branch,
              "--allow-empty",
            ],
            { cwd: rig.projectDir },
          );
          heads.push(
            Str.trim((yield* exec(["git", "rev-parse", "HEAD"], { cwd: rig.projectDir })).stdout),
          );
          yield* exec(["git", "push", "-q", "origin", branch], { cwd: rig.projectDir });
          yield* exec(["git", "switch", "-q", "master"], { cwd: rig.projectDir });
          yield* exec(["git", "branch", "-D", branch], { cwd: rig.projectDir });
        }
        const ready = `${rig.root}/ready`;
        const done = `${rig.root}/done`;
        yield* exec(["mkfifo", ready, done]);
        const bin = yield* FakeBin.make(`${rig.root}/fetch-bin`);
        yield* Effect.addFinalizer(() => bin.restore());
        yield* bin.add(
          "git",
          `case "$*" in
    'fetch origin '*first-topic*) /usr/bin/git "$@" || exit; printf 'ready\\n' > '${ready}'; read -r reply < '${done}' ;;
    'fetch origin '*second-topic*) read -r reply < '${ready}'; /usr/bin/git "$@" || exit; printf 'done\\n' > '${done}' ;;
    *) exec /usr/bin/git "$@" ;;
  esac`,
        );
        const placed = yield* Effect.all(
          Arr.map(["first-topic", "second-topic"], (branch) =>
            startCheckout(rig.pluginEnv(), rig.projectDir, { branch }, true),
          ),
          { concurrency: 2 },
        );
        yield* bin.restore();
        for (const [index, one] of placed.entries()) {
          expect(one).not.toHaveProperty("error");
          if ("error" in one) continue;
          expect(one.branchBase).toBe(heads[index]!);
          const checkout = yield* checkoutFor(new FakeHerdr(rig.pluginEnv()), {
            cwd: one.project,
            stateDir: rig.stateDir,
            name: `r-${index}`,
            workflow: "find-the-cause",
            checkout: "branch",
            inputs: {},
            explicit: one.options.branch,
            branchBase: one.branchBase,
          });
          expect(checkout.refused).toBeNull();
          expect(
            Str.trim((yield* exec(["git", "rev-parse", "HEAD"], { cwd: checkout.cwd })).stdout),
          ).toBe(heads[index]!);
        }
      }),
    ),
  120_000,
);
