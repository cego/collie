// `collie upgrade --to`: a released checkout moves to the exact version, a development
// checkout is never touched. Real git, because what counts as "released" is git's answer.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { shell } from "../src/mr";
import { upgrade } from "../src/operations";
import { installation } from "../src/release";

let rig: Rig;
let origin: string;
let clone: string;

const git = (cwd: string, ...args: string[]) =>
  exec(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: rig.root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).pipe(
    Effect.flatMap((done) =>
      done.exitCode === 0
        ? Effect.succeed(done.stdout.trim())
        : Effect.die(new Error(`git ${args.join(" ")}: ${done.stderr}`)),
    ),
  );

const release = Effect.fn("test.release")(function* (version: string) {
  yield* exec(
    ["sh", "-c", `echo 'echo "prepare: runner: done"' > prepare.sh; echo ${version} > version`],
    { cwd: origin },
  );
  yield* git(origin, "add", ".");
  yield* git(origin, "commit", "--quiet", "-m", version);
  yield* git(origin, "tag", version);
});

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      origin = `${rig.root}/origin`;
      clone = `${rig.root}/collie`;
      yield* exec(["mkdir", "-p", origin]);
      yield* git(origin, "init", "--quiet", "-b", "master");
      yield* release("0.1.0");
      yield* release("0.2.0");
      yield* git(rig.root, "clone", "--quiet", origin, clone);
      yield* git(clone, "reset", "--quiet", "--hard", "0.1.0");
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const env = () => ({ ...rig.pluginEnv(), pluginRoot: clone });

test("a released checkout moves to the exact version, and says what moved", () =>
  runEffect(
    Effect.gen(function* () {
      const before = yield* git(clone, "rev-parse", "--short", "HEAD");

      const moved = yield* upgrade(env(), { to: "0.2.0" });

      expect(moved).toMatchObject({
        ok: true,
        data: { checkout: true, updated: true, before, version: "0.2.0" },
      });
      expect(yield* git(clone, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.2.0");
      expect(moved.ok && moved.human).toContain(`from ${before} to `);
      expect(moved.ok && moved.human).toMatch(/runner\s+done/);
    }),
  ));

test("a checkout detached on a release tag is a release, whatever else is tagged there", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "checkout", "--quiet", "--detach", "0.1.0");
      yield* git(clone, "tag", "zzz-local");

      const moved = yield* upgrade(env(), { to: "0.2.0" });

      expect(moved).toMatchObject({ ok: true, data: { updated: true, version: "0.2.0" } });
    }),
  ));

test("a version with no release is refused and nothing moves", () =>
  runEffect(
    Effect.gen(function* () {
      const refused = yield* upgrade(env(), { to: "9.9.9" });

      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(yield* git(clone, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.1.0");
    }),
  ));

const refusedAsDevelopment = (reason: RegExp) =>
  Effect.gen(function* () {
    const head = yield* git(clone, "rev-parse", "HEAD");

    const refused = yield* upgrade(env(), { to: "0.2.0" });

    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(!refused.ok && refused.error.message).toMatch(reason);
    expect(yield* git(clone, "rev-parse", "HEAD")).toBe(head);
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
      yield* git(clone, "checkout", "--quiet", "-b", "feature");
      yield* refusedAsDevelopment(/branch feature/);
    }),
  ));

test("a checkout ahead of its remote is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "reset", "--quiet", "--hard", "origin/master");
      yield* git(clone, "commit", "--quiet", "--allow-empty", "-m", "local");
      yield* refusedAsDevelopment(/ahead of its remote/);
    }),
  ));

test("a checkout detached on a commit that is not a release is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "commit", "--quiet", "--allow-empty", "-m", "local");
      yield* git(clone, "checkout", "--quiet", "--detach", "HEAD");
      yield* refusedAsDevelopment(/not a release/);
    }),
  ));

test("a development build is named by its version and commit", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* installation(clone, "0.1.0")).toEqual({ release: true });

      yield* git(clone, "checkout", "--quiet", "-b", "feature");
      const sha = yield* git(clone, "rev-parse", "--short", "HEAD");
      expect(yield* installation(clone, "0.1.0")).toMatchObject({
        release: false,
        build: `0.1.0+${sha}`,
      });
    }),
  ));

// What Collie Desktop's launcher made every child of it write to stderr.
const LD_SO_NOISE = ["./libcef.so", "./libvk_swiftshader.so"].map(
  (lib) =>
    `ERROR: ld.so: object '${lib}' from LD_PRELOAD cannot be preloaded (cannot open shared object file): ignored.`,
);

const noisy = (cmd: string, args: string[], cwd: string) =>
  shell(
    "sh",
    ["-c", `printf '%s\\n' "$0" "$1" >&2; shift; exec "$@"`, ...LD_SO_NOISE, cmd, ...args],
    cwd,
  );

test("a clean released checkout is a release however noisy its tools' stderr", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* installation(clone, "0.1.0", noisy)).toEqual({ release: true });

      const moved = yield* upgrade(env(), { to: "0.2.0" }, noisy);

      expect(moved).toMatchObject({ ok: true, data: { updated: true, version: "0.2.0" } });
      expect(moved.ok && moved.human).toMatch(/runner\s+done/);
    }),
  ));

test("a noisy development build is named by its version and commit alone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "checkout", "--quiet", "-b", "feature");
      const sha = yield* git(clone, "rev-parse", "--short", "HEAD");

      expect(yield* installation(clone, "0.1.0", noisy)).toEqual({
        release: false,
        build: `0.1.0+${sha}`,
        reason: "it is on branch feature, not master",
      });
    }),
  ));

test("a noisy checkout with a real change is still refused for it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.promise(() => Bun.write(`${clone}/version`, "work in progress"));

      const refused = yield* upgrade(env(), { to: "0.2.0" }, noisy);

      expect(!refused.ok && refused.error.message).toMatch(/uncommitted changes/);
    }),
  ));

test("a failed fetch still says git's own reason", () =>
  runEffect(
    Effect.gen(function* () {
      yield* exec(["rm", "-rf", origin]);

      const refused = yield* upgrade(env(), { to: "0.2.0" }, noisy);

      expect(refused).toMatchObject({
        ok: false,
        error: { code: "operation_failed", details: { output: expect.stringContaining("fatal:") } },
      });
    }),
  ));
