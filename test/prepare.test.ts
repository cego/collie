// The one thing the shell scripts have never had a test for: that running them
// actually leaves a prepared machine behind. The real `prepare.sh` and `setup.sh`
// run in a temporary HOME with the fake-PATH rig in front of the outside world, and
// what is asserted is the state left behind rather than the steps taken to get there.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";
import { FakeBin } from "./support/bin";
import { prepareSteps } from "../src/operations";

let home: string;
let root: string;
let bin: FakeBin;

const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(yield* path.fromFileUrl(new URL(".", import.meta.url)), "..");
});

/** One of the install scripts, against the temporary HOME with only the stubs on PATH. */
function run(script: string, path = `${home}/stubs:/usr/bin:/bin`) {
  const result = Bun.spawnSync({
    cmd: ["sh", `${root}/${script}`],
    // Only the stubs and the system tools the scripts use: a real `herdr` on the
    // developer's own PATH would answer for one a test has deliberately removed.
    env: { HOME: home, PATH: path, HERDR_CONFIG: `${home}/.config/herdr/config.toml` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

const prepare = () => run("prepare.sh");
const setup = () => run("setup.sh");

/**
 * The host's tools, minus `npx`. `command -v npx` has to fail for the missing-CLI
 * path to be the one under test, and a machine with node in `/usr/bin` would
 * otherwise run the real skills CLI — which no test here may ever do.
 */
const withoutNpx = Effect.fn("prepareTest.withoutNpx")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tools = `${home}/tools`;
  yield* fs.makeDirectory(tools, { recursive: true });
  for (const dir of ["/usr/bin", "/bin"]) {
    if (!(yield* fs.exists(dir))) continue;
    for (const name of yield* fs.readDirectory(dir)) {
      if (name === "npx") continue;
      // First one wins, as PATH order would have decided anyway.
      yield* Effect.ignore(fs.symlink(`${dir}/${name}`, `${tools}/${name}`));
    }
  }
  return `${home}/stubs:${tools}`;
});

const read = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file));

const exists = (target: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(target));

const remove = (target: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.remove(target, { recursive: true, force: true }),
  );

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      home = yield* fs.makeTempDirectory({ prefix: "collie-prepare-" });
      root = `${home}/collie`;
      bin = yield* FakeBin.make(`${home}/stubs`);

      // A checkout, so install.sh builds from source rather than reaching the network.
      yield* fs.makeDirectory(`${root}/.git`, { recursive: true });
      const repo = yield* repoRoot;
      for (const file of ["prepare.sh", "install.sh", "setup.sh", "herdr-plugin.toml"]) {
        yield* fs.copyFile(`${repo}/${file}`, `${root}/${file}`);
      }
      // A source tree, because whether there is anything to build is answered by
      // comparing it against the binary.
      yield* fs.makeDirectory(`${root}/src`, { recursive: true });
      yield* fs.writeFileString(`${root}/src/main.ts`, "// the runner\n");
      yield* fs.copy(`${repo}/skills`, `${root}/skills`);

      // A git that records what it was asked to do, so a test can see a pull.
      yield* bin.add("git", `echo "$*" >> "${home}/git-calls"`);
      // A herdr that remembers what it was told to link, so a second run can see it.
      yield* bin.add(
        "herdr",
        `case "$1 $2" in
          "plugin list") cat "${home}/linked" 2>/dev/null || true ;;
          "plugin link") echo "cego.collie 0.1.0 [local:$3]" > "${home}/linked"; echo link >> "${home}/herdr-calls" ;;
        esac`,
      );
      // The build without the compiler: `bun run tools/build.ts` leaves an executable
      // at `bin/collie`, which is all install.sh does anything with — and leaves a
      // different one every time, as the real one does.
      yield* bin.add(
        "bun",
        `if [ "$1" = run ]; then
          echo build >> "${home}/builds"
          mkdir -p bin
          printf '#!/bin/sh\\necho "$@" >> "${home}/collie-calls"\\necho runner %s\\n' "$$" > bin/collie
          chmod +x bin/collie
        fi
        exit 0`,
      );
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* remove(home);
    }),
  ),
);

test("prepare leaves a linked plugin, a collie on PATH and the operator skill", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const first = prepare();

      expect(first.out).toContain("prepare: plugin-link: done");
      expect(first.out).toContain("prepare: runner: done");
      expect(first.out).toContain("prepare: operator-skill: done");
      expect(first.code).toBe(0);
      // Pinned, or the workflows would come from whatever directory it is run in.
      expect(yield* read(`${home}/.local/bin/collie`)).toContain(
        `HERDR_PLUGIN_ROOT="\${HERDR_PLUGIN_ROOT:-${root}}"`,
      );
      expect(yield* fs.exists(`${root}/bin/collie`)).toBe(true);
      // Both stores: claude-code reads only its own, everything else reads the
      // universal one, and the skill is no use to a harness that cannot see it.
      expect(yield* fs.readLink(`${home}/.claude/skills/collie`)).toBe(`${root}/skills/collie`);
      expect(yield* fs.readLink(`${home}/.agents/skills/collie`)).toBe(`${root}/skills/collie`);
      expect(yield* read(`${home}/linked`)).toContain(`local:${root}`);
    }),
  ));

test("a second run changes nothing and says every step is already in place", () =>
  runEffect(
    Effect.gen(function* () {
      prepare();
      const again = prepare();

      expect(again.out).toContain("prepare: plugin-link: already in place");
      expect(again.out).toContain("prepare: runner: already in place");
      expect(again.out).toContain("prepare: operator-skill: already in place");
      expect(again.code).toBe(0);
      // Linked once, not once per run: a re-link fires herdr's build hook.
      expect((yield* read(`${home}/herdr-calls`)).trim()).toBe("link");
    }),
  ));

test("what prepare reports is what `collie upgrade` reads back", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();

      // The real script's own output, through the real parser: the two halves of this
      // contract are a `printf` in sh and a regex in TypeScript, and nothing else
      // would notice a step line reworded on one side only.
      const steps = prepareSteps(prepare().out);

      expect(steps.map((s) => s.step)).toEqual([
        "plugin-link",
        "runner",
        "operator-skill",
        "skills",
      ]);
      expect(steps.every((s) => s.state !== "")).toBe(true);
    }),
  ));

test("a link that builds the runner is not a second build reported as no change", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // A herdr whose `plugin link` fires the build hook, as the real one does: the
      // runner exists by the time the routine reaches its own runner step.
      yield* bin.add(
        "herdr",
        `case "$1 $2" in
          "plugin list") cat "${home}/linked" 2>/dev/null || true ;;
          "plugin link") echo "cego.collie 0.1.0 [local:$3]" > "${home}/linked"
            mkdir -p "$3/bin"; : > "$3/bin/collie"; chmod +x "$3/bin/collie"
            echo build >> "${home}/builds" ;;
        esac`,
      );

      const run = prepare();

      // Built once, by the hook, and said so — not built again and called unchanged.
      expect(run.out).toContain("prepare: runner: done");
      expect((yield* read(`${home}/builds`)).trim()).toBe("build");
      expect(yield* fs.exists(`${home}/.local/bin/collie`)).toBe(false);
      expect(run.code).toBe(0);
    }),
  ));

test("an unchanged checkout is not rebuilt, and a changed one is", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      prepare();
      yield* remove(`${home}/builds`);

      const unchanged = prepare();

      // `bun build --compile` is seconds, and its output is not byte-identical run to
      // run, so rebuilding an unchanged checkout would cost that and report a change
      // that did not happen.
      expect(unchanged.out).toContain("prepare: runner: already in place");
      expect(yield* exists(`${home}/builds`)).toBe(false);

      yield* fs.writeFileString(`${root}/src/main.ts`, "// newer\n");
      const changed = prepare();

      expect(changed.out).toContain("prepare: runner: done");
      expect(yield* exists(`${home}/builds`)).toBe(true);
    }),
  ));

test("prepare never writes to the herdr config; keybindings are setup.sh's alone", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = `${home}/.config/herdr/config.toml`;
      yield* fs.makeDirectory(`${home}/.config/herdr`, { recursive: true });
      const before = '[server]\nkeep = "mine"\n';
      yield* fs.writeFileString(config, before);

      prepare();

      expect(yield* read(config)).toBe(before);
    }),
  ));

test("prepare says what it skipped rather than failing when herdr is absent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* remove(`${home}/stubs/herdr`);

      const run = prepare();

      expect(run.out).toContain("prepare: plugin-link: skipped");
      expect(run.out).toContain("prepare: runner: done");
      expect(run.code).toBe(0);
    }),
  ));

test("prepare leaves a skill link that is not ours alone", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${home}/.claude/skills/collie`, { recursive: true });

      const run = prepare();

      expect(run.out).toContain("prepare: operator-skill: skipped");
      expect(run.code).toBe(0);
      // The store we may not touch does not cost the other one its link.
      expect(yield* fs.readLink(`${home}/.agents/skills/collie`)).toBe(`${root}/skills/collie`);
    }),
  ));

/**
 * A skills.sh CLI that records what it was asked and populates the global store.
 * `updates` is what an `update` leaves behind, so a test can have upstream move.
 */
const fakeSkillsCli = (behaviour = "exit 0", updates = "") =>
  Effect.gen(function* () {
    yield* bin.add(
      "npx",
      `echo "$*" >> "${home}/npx-calls"
      if [ "$2" = add ] || [ "$3" = add ]; then
        mkdir -p "$HOME/.agents/skills/tdd" "$HOME/.claude/skills"
        echo "---" > "$HOME/.agents/skills/tdd/SKILL.md"
        ln -sfn "$HOME/.agents/skills/tdd" "$HOME/.claude/skills/tdd"
      fi
      if [ "$2" = update ] || [ "$3" = update ]; then
        ${updates || ":"}
      fi
      ${behaviour}`,
    );
  });

test("prepare installs the skills the workflows require into the global store", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fakeSkillsCli();

      const run = prepare();

      expect(run.out).toContain("prepare: skills: done");
      expect(run.code).toBe(0);
      // The store Collie's own skill lookup already searches, and a link for the one
      // harness that does not read it.
      expect(yield* fs.exists(`${home}/.agents/skills/tdd/SKILL.md`)).toBe(true);
      expect(yield* fs.readLink(`${home}/.claude/skills/tdd`)).toBe(`${home}/.agents/skills/tdd`);

      const asked = yield* read(`${home}/npx-calls`);
      // The two directories that make up the official bucket, by path — not the whole
      // repository, and not a list of skill names.
      expect(asked).toContain("mattpocock/skills/tree/main/skills/engineering");
      expect(asked).toContain("mattpocock/skills/tree/main/skills/productivity");
      expect(asked).toContain("addyosmani/agent-skills");
      // Never waiting for an answer, and always taking the latest upstream state.
      expect(asked).toContain("-y");
      expect(asked).toContain("update -g -y");
    }),
  ));

test("a second run updates the skills without adding them again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();
      prepare();
      yield* remove(`${home}/npx-calls`);

      const again = prepare();

      expect(again.out).toContain("prepare: skills: already in place");
      const asked = yield* read(`${home}/npx-calls`);
      expect(asked).not.toContain("add");
      expect(asked).toContain("update -g -y");
    }),
  ));

test("a skill deleted by hand is added again rather than called already in place", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();
      prepare();
      // The store is what the stamp is checked against, so removing from it is the
      // one thing that has to make the next run add rather than skip.
      yield* remove(`${home}/.agents/skills/tdd`);
      yield* remove(`${home}/npx-calls`);

      const again = prepare();

      expect(again.out).toContain("prepare: skills: done");
      expect(yield* read(`${home}/npx-calls`)).toContain("add");
      expect(yield* exists(`${home}/.agents/skills/tdd`)).toBe(true);
    }),
  ));

test("an update that brings a new version is reported as done, not as unchanged", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();
      prepare();

      // Nothing to add — the sources have not changed — but upstream has moved, and
      // the version this machine now runs is the only thing that happened.
      yield* fakeSkillsCli("exit 0", `echo "newer" > "$HOME/.agents/skills/tdd/SKILL.md"`);
      const again = prepare();

      expect(again.out).toContain("prepare: skills: done");
      expect(yield* read(`${home}/npx-calls`)).toContain("update -g -y");
    }),
  ));

test("an update that cannot run does not make the next run clone everything again", () =>
  runEffect(
    Effect.gen(function* () {
      // The sources are in; what fails afterwards is the CLI's own global update,
      // which reaches skills this machine has that Collie did not put there.
      yield* fakeSkillsCli(`case "$2$3" in *update*) exit 1 ;; esac`);
      const first = prepare();
      yield* remove(`${home}/npx-calls`);

      const again = prepare();

      expect(first.out).toContain("prepare: skills: skipped");
      expect(again.out).toContain("prepare: skills: skipped");
      // Adding them again would be three clones, every upgrade, for someone else's
      // broken source.
      expect(yield* read(`${home}/npx-calls`)).not.toContain("add");
    }),
  ));

test("no skills CLI is a reported skip, not a failed install", () =>
  runEffect(
    Effect.gen(function* () {
      const done = run("prepare.sh", yield* withoutNpx());

      expect(done.out).toContain("prepare: skills: skipped");
      expect(done.out).toContain("collie upgrade");
      // The rest of the machine is still prepared.
      expect(done.out).toContain("prepare: runner: done");
      expect(done.code).toBe(0);
    }),
  ));

test("a skills CLI that fails is a reported skip, not a failed install", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli("echo 'network is unreachable' >&2; exit 1");

      const run = prepare();

      expect(run.out).toContain("prepare: skills: skipped");
      expect(run.out).toContain("prepare: runner: done");
      expect(run.code).toBe(0);
    }),
  ));

test("re-running setup from the checkout updates it, and keeps the keybindings", () =>
  runEffect(
    Effect.gen(function* () {
      // The documented install is a clone followed by this script, so running the
      // same command again has to be how a teammate gets newer — the checkout is
      // where the workflows, personas and skills live, not just the runner.
      const first = setup();
      const again = setup();

      const asked = yield* read(`${home}/git-calls`);
      expect(asked).toContain("-C " + root + " pull --ff-only");
      expect(asked.split("\n").filter((line) => line.includes("pull")).length).toBe(2);
      expect(first.code).toBe(0);
      expect(again.code).toBe(0);

      // Its own first-time-only work, and nothing about it repeated.
      const config = yield* read(`${home}/.config/herdr/config.toml`);
      expect(config.split("cego.collie.pick").length - 1).toBe(1);
      expect(again.out).toContain("Keybinding for pick already present");
      // And it ends in doctor, which is the runner this fixture built.
      expect(again.out).toContain("runner");
    }),
  ));

test("a pull it cannot do does not end the install", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add(
        "git",
        `case "$*" in
          *pull*) echo "would clobber local changes" >&2; exit 1 ;;
          *) exit 0 ;;
        esac`,
      );

      const done = setup();

      expect(done.out).toContain("Could not update");
      // Someone with work in progress here still wants the rest of the run.
      expect(done.out).toContain("prepare: runner:");
      expect(done.code).toBe(0);
    }),
  ));

test("setup configures Claude Code's status line; prepare never touches it", () =>
  runEffect(
    Effect.gen(function* () {
      // The human's own Claude Code config, like the keybindings: asked for once, by the
      // script a teammate runs on purpose, and never by the routine that rebuilds a
      // runner. The runner is what edits the file, so the step is a call rather than a
      // shell script writing JSON.
      prepare();
      // Prepare does call the runner — it reads what an older Collie recorded — so what
      // this is about is the one thing it must never ask for.
      const afterPrepare = (yield* exists(`${home}/collie-calls`))
        ? yield* read(`${home}/collie-calls`)
        : "";
      expect(afterPrepare).not.toContain("chat status-line");

      setup();

      expect(yield* read(`${home}/collie-calls`)).toContain("chat status-line --install");
    }),
  ));
