// `collie upgrade --to`: a released checkout moves to the exact version, a development
// checkout is never touched. Real git, because what counts as "released" is git's answer.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { upgrade } from "../src/operations";
import { installation } from "../src/release";

let rig: Rig;
let origin: string;
let clone: string;

const git = (cwd: string, ...args: string[]) => {
  const done = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: rig.root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
  return done.stdout.toString().trim();
};

const release = (version: string) => {
  Bun.spawnSync(
    ["sh", "-c", `echo 'echo "prepare: runner: done"' > prepare.sh; echo ${version} > version`],
    { cwd: origin },
  );
  git(origin, "add", ".");
  git(origin, "commit", "--quiet", "-m", version);
  git(origin, "tag", version);
};

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      origin = `${rig.root}/origin`;
      clone = `${rig.root}/collie`;
      Bun.spawnSync(["mkdir", "-p", origin]);
      git(origin, "init", "--quiet", "-b", "master");
      release("0.1.0");
      release("0.2.0");
      git(rig.root, "clone", "--quiet", origin, clone);
      git(clone, "reset", "--quiet", "--hard", "0.1.0");
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const env = () => ({ ...rig.pluginEnv(), pluginRoot: clone });

test("a released checkout moves to the exact version, and says what moved", () =>
  runEffect(
    Effect.gen(function* () {
      const before = git(clone, "rev-parse", "--short", "HEAD");

      const moved = yield* upgrade(env(), { to: "0.2.0" });

      expect(moved).toMatchObject({
        ok: true,
        data: { checkout: true, updated: true, before, version: "0.2.0" },
      });
      expect(git(clone, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.2.0");
      expect(moved.ok && moved.human).toContain(`from ${before} to `);
      expect(moved.ok && moved.human).toMatch(/runner\s+done/);
    }),
  ));

test("a checkout detached on a release tag is a release, whatever else is tagged there", () =>
  runEffect(
    Effect.gen(function* () {
      git(clone, "checkout", "--quiet", "--detach", "0.1.0");
      git(clone, "tag", "zzz-local");

      const moved = yield* upgrade(env(), { to: "0.2.0" });

      expect(moved).toMatchObject({ ok: true, data: { updated: true, version: "0.2.0" } });
    }),
  ));

test("a version with no release is refused and nothing moves", () =>
  runEffect(
    Effect.gen(function* () {
      const refused = yield* upgrade(env(), { to: "9.9.9" });

      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(git(clone, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.1.0");
    }),
  ));

const refusedAsDevelopment = (reason: RegExp) =>
  Effect.gen(function* () {
    const head = git(clone, "rev-parse", "HEAD");

    const refused = yield* upgrade(env(), { to: "0.2.0" });

    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(!refused.ok && refused.error.message).toMatch(reason);
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });

test("a checkout with uncommitted changes is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.promise(() => Bun.write(`${clone}/version`, "work in progress"));
      yield* refusedAsDevelopment(/uncommitted changes/);
      expect(yield* Effect.promise(() => Bun.file(`${clone}/version`).text())).toBe(
        "work in progress",
      );
    }),
  ));

test("a checkout on a branch of its own is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      git(clone, "checkout", "--quiet", "-b", "feature");
      yield* refusedAsDevelopment(/branch feature/);
    }),
  ));

test("a checkout ahead of its remote is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      git(clone, "reset", "--quiet", "--hard", "origin/master");
      git(clone, "commit", "--quiet", "--allow-empty", "-m", "local");
      yield* refusedAsDevelopment(/ahead of its remote/);
    }),
  ));

test("a checkout detached on a commit that is not a release is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      git(clone, "commit", "--quiet", "--allow-empty", "-m", "local");
      git(clone, "checkout", "--quiet", "--detach", "HEAD");
      yield* refusedAsDevelopment(/not a release/);
    }),
  ));

test("a development build is named by its version and commit", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* installation(clone, "0.1.0")).toEqual({ release: true });

      git(clone, "checkout", "--quiet", "-b", "feature");
      const sha = git(clone, "rev-parse", "--short", "HEAD");
      expect(yield* installation(clone, "0.1.0")).toMatchObject({
        release: false,
        build: `0.1.0+${sha}`,
      });
    }),
  ));
