// What `collie upgrade` does to an installation, and what it says it did.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { Rig, TEST_LOGIN } from "./support/recorder";
import { installBaseline } from "./support/engine";
import { installFakeSkills } from "./support/defs";
import { FakeBin } from "./support/bin";
import { upgrade } from "../src/operations";

let rig: Rig;
let bin: FakeBin;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(`${rig.root}/bin`);
      yield* installFakeSkills(rig.root);
      // Inference shells out; nothing here depends on what it finds.
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

const PREPARED = [
  "prepare: plugin-link: already in place",
  "prepare: runner: done",
  "prepare: operator-skill: done",
  "prepare: skills: skipped — no npx on PATH; install Node, then run `collie upgrade`",
].join("\n");

/** A checkout that answers `git` and a `prepare.sh` that says what it did. */
const fakeTools = Effect.fn("operationsTest.fakeTools")(function* (opts: {
  head: string;
  pull?: string;
  install?: string;
}) {
  yield* bin.add(
    "git",
    `case "$1 $2" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --short") echo ${opts.head} ;;
      "pull --ff-only") ${opts.pull ?? "echo Updating; exit 0"} ;;
      *) exit 1 ;;
    esac`,
  );
  // A marker, so a test can tell "the preparation ran" from "it was never reached".
  yield* bin.add(
    "sh",
    opts.install ??
      `touch "${rig.root}/installed"; cat <<'OUT'
${PREPARED}
OUT`,
  );
});

test("upgrade pulls the checkout, then installs, and says what moved", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      yield* fakeTools({ head: "abc1234" });

      const same = yield* upgrade(env);

      // Nothing moved: the same HEAD before and after is worth saying plainly rather
      // than reporting an update that did not happen.
      expect(same).toMatchObject({
        ok: true,
        data: { checkout: true, updated: false },
      });
      expect(same.ok && same.human).toContain("already up to date at abc1234");
      // Every step of preparing the machine, so "nothing to do" reads differently
      // from "the runner updated but the skills step could not run".
      expect(same.ok && same.human).toMatch(/plugin-link\s+already in place/);
      expect(same.ok && same.human).toMatch(/runner\s+done/);
      expect(same.ok && same.human).toMatch(/skills\s+skipped — no npx on PATH/);
      expect(same).toMatchObject({
        data: {
          steps: [
            { step: "plugin-link", state: "already in place" },
            { step: "runner", state: "done" },
            { step: "operator-skill", state: "done" },
            { step: "skills", state: "skipped" },
          ],
        },
      });
    }),
  ));

test("upgrade reports a pull it could not do rather than installing anyway", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      // A dirty tree, a diverged branch, no upstream: all the same answer.
      yield* fakeTools({
        head: "abc1234",
        pull: `echo "would clobber local changes" >&2; exit 1`,
      });

      const refused = yield* upgrade(env);

      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: "operation_failed",
          details: { output: "would clobber local changes" },
        },
      });
      // And it did not go on to install over the top of whatever is there.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${rig.root}/installed`)).toBe(false);
    }),
  ));

test("upgrade that moves the checkout says the range it moved through", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      // A HEAD that differs before and after the pull: the commit range is what tells
      // "you are now three commits newer" from "nothing to do".
      yield* bin.add(
        "git",
        `case "$1 $2" in
          "rev-parse --git-dir") echo .git ;;
          "rev-parse --short") if [ -f "${rig.root}/pulled" ]; then echo def5678; else echo abc1234; fi ;;
          "pull --ff-only") touch "${rig.root}/pulled"; echo Updating ;;
          *) exit 1 ;;
        esac`,
      );
      yield* bin.add(
        "sh",
        `cat <<'OUT'
${PREPARED}
OUT`,
      );

      const moved = yield* upgrade(env);

      expect(moved).toMatchObject({
        ok: true,
        data: {
          checkout: true,
          updated: true,
          before: "abc1234",
          after: "def5678",
        },
      });
      expect(moved.ok && moved.human).toContain("from abc1234 to def5678");
      expect(moved.ok && moved.human).toMatch(/skills\s+skipped/);
    }),
  ));

test("upgrade of a plain install fetches the release without asking git anything", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      // Not a checkout: `git rev-parse --git-dir` fails, and there is nothing to pull.
      yield* bin.add("git", `exit 1`);
      yield* bin.add("sh", `echo installed collie-linux-x64; exit 0`);

      const fetched = yield* upgrade(env);

      expect(fetched).toMatchObject({
        ok: true,
        data: { checkout: false, updated: false },
      });
      expect(fetched.ok && fetched.human).toContain("not a checkout");
    }),
  ));
