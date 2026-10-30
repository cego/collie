// Checkouts of Collie. A development checkout is pulled with its work riding through and never
// moved to a release. Real git, because what counts is git's answer.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { shell } from "../src/mr";
import { upgrade } from "../src/operations";
import { installation, isCheckout } from "../src/release";

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
        ? Effect.succeed(Str.trim(done.stdout))
        : Effect.die(new Error(`git ${Arr.join(args, " ")}: ${done.stderr}`)),
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

const development = () => ({
  ...rig.pluginEnv(),
  pluginRoot: clone,
  collieDir: `${rig.root}/elsewhere`,
});

test("a clone at the Collie directory is the installation, whatever its state", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "checkout", "--quiet", "-b", "feature");
      expect(yield* installation(clone, clone, "0.1.0")).toEqual({ release: true });
    }),
  ));

// What Collie Desktop's launcher made every child of it write to stderr.
const LD_SO_NOISE = Arr.map(
  ["./libcef.so", "./libvk_swiftshader.so"],
  (lib) =>
    `ERROR: ld.so: object '${lib}' from LD_PRELOAD cannot be preloaded (cannot open shared object file): ignored.`,
);

const noisy = (cmd: string, args: string[], cwd: string) =>
  shell(
    "sh",
    ["-c", `printf '%s\\n' "$0" "$1" >&2; shift; exec "$@"`, ...LD_SO_NOISE, cmd, ...args],
    cwd,
  );

test("a noisy development build is named by its version and commit alone", () =>
  runEffect(
    Effect.gen(function* () {
      const sha = yield* git(clone, "rev-parse", "--short", "HEAD");

      expect(yield* installation(clone, `${rig.root}/elsewhere`, "0.1.0", noisy)).toEqual({
        release: false,
        build: `0.1.0+${sha}`,
        reason: "it is a development checkout",
      });
    }),
  ));

test("a development checkout pulls, and its uncommitted work rides through", () =>
  runEffect(
    Effect.gen(function* () {
      // A file of the clone's own that the next release does not touch, edited and uncommitted.
      yield* exec(["sh", "-c", "echo shipped > notes.md"], { cwd: origin });
      yield* git(origin, "add", "notes.md");
      yield* git(origin, "commit", "--quiet", "-m", "notes");
      yield* release("0.3.0");
      yield* git(clone, "fetch", "--quiet");
      yield* git(clone, "reset", "--quiet", "--hard", "origin/master~1");
      yield* Effect.promise(() => Bun.write(`${clone}/notes.md`, "work in progress\n"));
      // As many developers pull: a rebase refuses a dirty tree unless the work is stashed.
      yield* git(clone, "config", "pull.rebase", "true");

      const pulled = yield* upgrade(development());

      expect(pulled).toMatchObject({ ok: true, data: { updated: true } });
      expect(yield* git(clone, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.3.0");
      expect(yield* Effect.promise(() => Bun.file(`${clone}/notes.md`).text())).toBe(
        "work in progress\n",
      );
    }),
  ));

test("a development checkout is never moved to a release", () =>
  runEffect(
    Effect.gen(function* () {
      const head = yield* git(clone, "rev-parse", "HEAD");

      const refused = yield* upgrade(development(), { to: "0.2.0" });

      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(yield* git(clone, "rev-parse", "HEAD")).toBe(head);
    }),
  ));

test("a checkout other than the Collie directory is development, whatever its state", () =>
  runEffect(
    Effect.gen(function* () {
      const sha = yield* git(clone, "rev-parse", "--short", "HEAD");
      expect(yield* installation(clone, `${rig.root}/elsewhere`, "0.1.0")).toEqual({
        release: false,
        build: `0.1.0+${sha}`,
        reason: "it is a development checkout",
      });
    }),
  ));

test("a release placed inside a kept clone is a release, never the clone's checkout", () =>
  runEffect(
    Effect.gen(function* () {
      yield* exec(["mkdir", "-p", `${clone}/release`]);

      expect(yield* isCheckout(`${clone}/release`)).toBe(false);
      expect(yield* installation(`${clone}/release`, clone, "0.1.0")).toEqual({ release: true });
      expect(yield* isCheckout(clone)).toBe(true);
    }),
  ));

test("work that conflicts with the pull is reported in git's words, and nothing is prepared", () =>
  runEffect(
    Effect.gen(function* () {
      yield* exec(["sh", "-c", "echo shipped > notes.md"], { cwd: origin });
      yield* git(origin, "add", "notes.md");
      yield* git(origin, "commit", "--quiet", "-m", "notes");
      yield* git(clone, "pull", "--quiet", "--ff-only");
      yield* exec(["sh", "-c", "echo upstream > notes.md"], { cwd: origin });
      yield* git(origin, "commit", "--quiet", "-am", "upstream notes");
      yield* Effect.promise(() => Bun.write(`${clone}/notes.md`, "mine\n"));
      yield* Effect.promise(() =>
        Bun.write(`${clone}/prepare.sh`, `echo ran > "${rig.root}/prepared"\n`),
      );
      yield* git(clone, "update-index", "--assume-unchanged", "prepare.sh");

      const refused = yield* upgrade(development());

      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: "operation_failed",
          details: { output: expect.stringMatching(/conflict/i) },
        },
      });
      expect(yield* Effect.promise(() => Bun.file(`${rig.root}/prepared`).exists())).toBe(false);
    }),
  ));
