import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { installBaseline } from "./support/engine";
import { installFakeSkills } from "./support/defs";
import { FakeBin } from "./support/bin";
import { upgrade } from "../src/operations";
import { answerRead } from "../src/tools";
import { readEnv } from "../src/env";
import type { RunProgress, TaskMr } from "../src/board-model";
import { madeRun } from "./support/records";
import { recordsAt } from "../src/records";

let rig: Rig;
let bin: FakeBin;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(`${rig.root}/bin`);
      yield* installFakeSkills(rig.root);
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

const PREPARED = Arr.join(
  [
    "prepare: plugin-link: already in place",
    "prepare: runner: done",
    "prepare: operator-skill: done",
    "prepare: skills: skipped — no npx on PATH; install Node, then run `collie upgrade`",
  ],
  "\n",
);

const fakeTools = Effect.fn("operationsTest.fakeTools")(function* (opts: {
  head: string;
  pull?: string;
  install?: string;
}) {
  yield* bin.add(
    "git",
    `case "$1 $2" in
      "rev-parse --show-prefix") echo ;;
      "rev-parse --short") echo ${opts.head} ;;
      "pull --ff-only") ${opts.pull ?? "echo Updating; exit 0"} ;;
      *) exit 1 ;;
    esac`,
  );
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

      expect(same).toMatchObject({
        ok: true,
        data: { checkout: true, updated: false },
      });
      expect(same.ok && same.human).toContain("already up to date at abc1234");
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
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${rig.root}/installed`)).toBe(false);
    }),
  ));

test("upgrade that moves the checkout says the range it moved through", () =>
  runEffect(
    Effect.gen(function* () {
      const env = { ...rig.pluginEnv(), pluginRoot: rig.projectDir };
      yield* bin.add(
        "git",
        `case "$1 $2" in
          "rev-parse --show-prefix") echo ;;
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

const shaOf = (digit: string) => Arr.join(Arr.replicate(digit, 40), "");

const taskMr: (repo: string, iid: number, over?: Partial<TaskMr>) => TaskMr = (
  repo,
  iid,
  over = {},
) => ({
  id: `gitlab.cego.dk/cego/${repo}!${iid}`,
  mr: `https://gitlab.cego.dk/cego/${repo}/-/merge_requests/${iid}`,
  label: `cego/${repo}!${iid}`,
  short: `${repo}!${iid}`,
  url: `https://gitlab.cego.dk/cego/${repo}/-/merge_requests/${iid}`,
  run: `r-${repo}`,
  state: "open",
  checks: null,
  head: null,
  ready: false,
  disposition: null,
  waitsOn: [],
  ...over,
});

test("collie_run on a Task of several merge requests names each, ready at its head or waiting on another", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "collie-run-mrs-",
      });
      yield* Layer.build(recordsAt(dir));
      const env = readEnv({ COLLIE_STATE_DIR: dir, COLLIE_CWD: "/project" });
      const run = yield* madeRun(dir, { id: "r-fan", task: "task-1", state: "succeeded" });
      const app = taskMr("app", 12, { ready: true, head: shaOf("a") });
      const api = taskMr("api", 7, { waitsOn: [app.id] });
      const progress: RunProgress = {
        ready: { ready: true, missing: [] },
        ci: null,
        steps: [],
        mrs: [app, api],
      };

      const said = yield* answerRead(
        env,
        "collie_run",
        { run: run.id },
        {
          runs: Effect.succeed([run]),
          offers: () => Effect.succeed("(none)"),
          progress: () => Effect.succeed(progress),
          flow: () => Effect.succeed(null),
          launches: () => Effect.succeed([]),
        },
      );

      expect(said).toContain(
        Arr.join(
          [
            "### Ready to release",
            "",
            "- app!12: open, ready to release at aaaaaaaa",
            "- api!7: open, not ready to release, waits on app!12",
          ],
          "\n",
        ),
      );
    }),
  ));
