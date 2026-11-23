import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { FakeBin } from "./support/bin";
import { generateKeyPairSync } from "node:crypto";
import { prepareSteps } from "../src/operations";
import { signReleaseP256 } from "../src/signing";

let home: string;
let root: string;
let bin: FakeBin;

const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(yield* path.fromFileUrl(new URL(".", import.meta.url)), "..");
});

const run = (
  script: string,
  path = `${home}/stubs:/usr/bin:/bin`,
  extra: Record<string, string> = {},
) =>
  exec(["sh", `${root}/${script}`], {
    env: { HOME: home, PATH: path, ...extra },
  }).pipe(Effect.map((result) => ({ code: result.exitCode, out: result.stdout + result.stderr })));

const prepare = () => run("prepare.sh");

// WARNING: without npx the missing-CLI path is under test; node in /usr/bin would run the real skills CLI.
const withoutNpx = Effect.fn("prepareTest.withoutNpx")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tools = `${home}/tools`;
  yield* fs.makeDirectory(tools, { recursive: true });
  for (const dir of ["/usr/bin", "/bin"]) {
    if (!(yield* fs.exists(dir))) continue;
    for (const name of yield* fs.readDirectory(dir)) {
      if (name === "npx") continue;
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

      yield* fs.makeDirectory(`${root}/.git`, { recursive: true });
      const repo = yield* repoRoot;
      for (const file of ["prepare.sh", "install.sh", "package.json", "release-p256.pub"]) {
        yield* fs.copyFile(`${repo}/${file}`, `${root}/${file}`);
      }
      yield* fs.makeDirectory(`${root}/src`, { recursive: true });
      yield* fs.writeFileString(`${root}/src/main.ts`, "// the runner\n");
      yield* fs.copy(`${repo}/skills`, `${root}/skills`);

      yield* bin.add("git", `echo "$*" >> "${home}/git-calls"`);
      yield* bin.add("herdr", `echo "$*" >> "${home}/herdr-calls"; exit 127`);
      yield* bin.add(
        "bun",
        `if [ "$1" = run ]; then
          echo build >> "${home}/builds"
          mkdir -p bin
          printf '#!/bin/sh\\n[ "$1" = x ] && shift && exec skills "$@"\\necho "$@" >> "${home}/collie-calls"\\necho runner %s\\n' "$$" > bin/collie
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
      const calledHerdr = yield* exists(`${home}/herdr-calls`);
      yield* bin.restore();
      yield* remove(home);
      expect(calledHerdr).toBe(false);
    }),
  ),
);

test("prepare leaves Collie on PATH and the operator skill without a plugin", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const first = yield* prepare();

      expect(first.out).toContain("prepare: runner: done");
      expect(first.out).toContain("prepare: operator-skill: done");
      expect(first.code).toBe(0);
      expect(yield* read(`${home}/.local/bin/collie`)).toContain(
        `COLLIE_ROOT="\${COLLIE_ROOT:-${root}}"`,
      );
      expect(yield* fs.exists(`${root}/bin/collie`)).toBe(true);
      // WARNING: claude-code reads only its own store; everything else reads the universal one.
      expect(yield* fs.readLink(`${home}/.claude/skills/collie`)).toBe(`${root}/skills/collie`);
      expect(yield* fs.readLink(`${home}/.agents/skills/collie`)).toBe(`${root}/skills/collie`);
    }),
  ));

test("a second run changes nothing and says every step is already in place", () =>
  runEffect(
    Effect.gen(function* () {
      yield* prepare();
      const again = yield* prepare();

      expect(again.out).toContain("prepare: runner: already in place");
      expect(again.out).toContain("prepare: operator-skill: already in place");
      expect(again.code).toBe(0);
    }),
  ));

test("what prepare reports is what `collie upgrade` reads back", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();

      const steps = prepareSteps((yield* prepare()).out);

      expect(Arr.map(steps, (s) => s.step)).toEqual(["runner", "operator-skill", "skills"]);
      expect(Arr.every(steps, (s) => s.state !== "")).toBe(true);
    }),
  ));

test("an unchanged checkout is not rebuilt, and a changed one is", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* prepare();
      yield* remove(`${home}/builds`);

      const unchanged = yield* prepare();

      // WARNING: bun build --compile is seconds and not byte-identical, so a rebuild would report a change that did not happen.
      expect(unchanged.out).toContain("prepare: runner: already in place");
      expect(yield* exists(`${home}/builds`)).toBe(false);

      yield* fs.writeFileString(`${root}/src/main.ts`, "// newer\n");
      const changed = yield* prepare();

      expect(changed.out).toContain("prepare: runner: done");
      expect(yield* exists(`${home}/builds`)).toBe(true);
    }),
  ));

test("prepare installs normally when Herdr is absent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* remove(`${home}/stubs/herdr`);

      const run = yield* prepare();

      expect(run.out).not.toContain("plugin-link");
      expect(run.out).toContain("prepare: runner: done");
      expect(run.code).toBe(0);
    }),
  ));

test("prepare leaves a skill link that is not ours alone", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${home}/.claude/skills/collie`, { recursive: true });

      const run = yield* prepare();

      expect(run.out).toContain("prepare: operator-skill: skipped");
      expect(run.code).toBe(0);
      expect(yield* fs.readLink(`${home}/.agents/skills/collie`)).toBe(`${root}/skills/collie`);
    }),
  ));

test("prepare repoints a skill link to another Collie installation, as a clone install's is", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const clone = `${home}/old-clone`;
      yield* fs.makeDirectory(`${clone}/skills/collie`, { recursive: true });
      yield* fs.writeFileString(`${clone}/package.json`, `{"name":"collie"}\n`);
      yield* fs.makeDirectory(`${home}/.claude/skills`, { recursive: true });
      yield* fs.symlink(`${clone}/skills/collie`, `${home}/.claude/skills/collie`);

      const run = yield* prepare();

      expect(run.out).toContain("prepare: operator-skill: done");
      expect(yield* fs.readLink(`${home}/.claude/skills/collie`)).toBe(`${root}/skills/collie`);
    }),
  ));

const fakeSkillsCli = (behaviour = "exit 0", updates = "") =>
  Effect.suspend(() =>
    bin.add(
      "skills",
      `echo "BUN_BE_BUN=$BUN_BE_BUN $*" >> "${home}/skills-calls"
      if [ "$2" = add ]; then
        mkdir -p "$HOME/.agents/skills/tdd" "$HOME/.claude/skills"
        echo "---" > "$HOME/.agents/skills/tdd/SKILL.md"
        ln -sfn "$HOME/.agents/skills/tdd" "$HOME/.claude/skills/tdd"
      fi
      if [ "$2" = update ]; then
        ${updates || ":"}
      fi
      ${behaviour}`,
    ),
  );

test("prepare installs the skills the workflows require into the global store", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fakeSkillsCli();

      const run = yield* prepare();

      expect(run.out).toContain("prepare: skills: done");
      expect(run.code).toBe(0);
      expect(yield* fs.exists(`${home}/.agents/skills/tdd/SKILL.md`)).toBe(true);
      expect(yield* fs.readLink(`${home}/.claude/skills/tdd`)).toBe(`${home}/.agents/skills/tdd`);

      const asked = yield* read(`${home}/skills-calls`);
      expect(asked).toContain("mattpocock/skills/tree/main/skills/engineering");
      expect(asked).toContain("mattpocock/skills/tree/main/skills/productivity");
      expect(asked).toContain("addyosmani/agent-skills");
      expect(asked).toContain("-y");
      expect(asked).toContain("update -g -y");
    }),
  ));

test("a second run updates the skills without adding them again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();
      yield* prepare();
      yield* remove(`${home}/skills-calls`);

      const again = yield* prepare();

      expect(again.out).toContain("prepare: skills: already in place");
      const asked = yield* read(`${home}/skills-calls`);
      expect(asked).not.toContain("add");
      expect(asked).toContain("update -g -y");
    }),
  ));

test("a skill deleted by hand is added again rather than called already in place", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();
      yield* prepare();
      // WARNING: the store is what the stamp is checked against; removing from it makes the next run add, not skip.
      yield* remove(`${home}/.agents/skills/tdd`);
      yield* remove(`${home}/skills-calls`);

      const again = yield* prepare();

      expect(again.out).toContain("prepare: skills: done");
      expect(yield* read(`${home}/skills-calls`)).toContain("add");
      expect(yield* exists(`${home}/.agents/skills/tdd`)).toBe(true);
    }),
  ));

test("an update that brings a new version is reported as done, not as unchanged", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();
      yield* prepare();

      yield* fakeSkillsCli("exit 0", `echo "newer" > "$HOME/.agents/skills/tdd/SKILL.md"`);
      const again = yield* prepare();

      expect(again.out).toContain("prepare: skills: done");
      expect(yield* read(`${home}/skills-calls`)).toContain("update -g -y");
    }),
  ));

test("an update that cannot run does not make the next run clone everything again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli(`case "$2" in update) exit 1 ;; esac`);
      const first = yield* prepare();
      yield* remove(`${home}/skills-calls`);

      const again = yield* prepare();

      expect(first.out).toContain("prepare: skills: skipped");
      expect(again.out).toContain("prepare: skills: skipped");
      expect(yield* read(`${home}/skills-calls`)).not.toContain("add");
    }),
  ));

test("the skills install through the runner's own Bun, with no Node on the machine", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli();

      const done = yield* run("prepare.sh", yield* withoutNpx());

      expect(done.out).toContain("prepare: skills: done");
      expect(yield* read(`${home}/skills-calls`)).toContain("BUN_BE_BUN=1 skills@");
      expect(done.code).toBe(0);
    }),
  ));

test("a skills CLI that fails is a reported skip, not a failed install", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeSkillsCli("echo 'network is unreachable' >&2; exit 1");

      const run = yield* prepare();

      expect(run.out).toContain("prepare: skills: skipped");
      expect(run.out).toContain("prepare: runner: done");
      expect(run.code).toBe(0);
    }),
  ));

test("prepare never configures Claude Code's status line; that is setup.sh's", () =>
  runEffect(
    Effect.gen(function* () {
      yield* prepare();
      const asked = (yield* exists(`${home}/collie-calls`))
        ? yield* read(`${home}/collie-calls`)
        : "";
      expect(asked).not.toContain("chat status-line");
    }),
  ));

test("in a release, prepare keeps the placed runner and downloads nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* remove(`${root}/.git`);
      yield* fs.writeFileString(`${root}/placed.json`, `{"version":"0.1.0","files":{}}`);
      yield* fs.makeDirectory(`${root}/bin`, { recursive: true });
      yield* fs.writeFileString(`${root}/bin/collie`, "#!/bin/sh\n# the placed runner\n");
      yield* fs.chmod(`${root}/bin/collie`, 0o755);
      yield* bin.add("curl", `echo "$*" >> "${home}/downloads"; exit 1`);

      const done = yield* prepare();

      expect(done.code).toBe(0);
      expect(done.out).toContain("prepare: runner: already in place");
      expect(yield* read(`${root}/bin/collie`)).toBe("#!/bin/sh\n# the placed runner\n");
      expect(yield* exists(`${home}/downloads`)).toBe(false);
      expect(yield* exists(`${home}/builds`)).toBe(false);
      expect(yield* read(`${home}/.local/bin/collie`)).toContain(`"${root}/bin/collie"`);
    }),
  ));

const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const downloadable = Effect.fn("prepareTest.downloadable")(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* remove(`${root}/.git`);
  yield* remove(`${home}/stubs/bun`);
  const { publicKey, privateKey } = p256();
  yield* fs.writeFileString(
    `${root}/release-p256.pub`,
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  const asset = `${home}/release/collie-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const runner = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, ...new TextEncoder().encode(" new")]);
  yield* fs.makeDirectory(`${home}/release`, { recursive: true });
  yield* fs.writeFile(asset, runner);
  yield* fs.makeDirectory(`${root}/bin`, { recursive: true });
  yield* fs.writeFileString(`${root}/bin/collie`, "the runner already here");
  const signature = (key = privateKey) =>
    fs.writeFileString(
      `${asset}.p256.sig`,
      signReleaseP256(runner, key.export({ type: "pkcs8", format: "pem" }).toString()),
    );
  const install = (extra: Record<string, string> = {}) =>
    run("install.sh", undefined, {
      COLLIE_RELEASE_BASE: `file://${home}/release`,
      COLLIE_PREPARING: "1",
      COLLIE_OPENSSL: Bun.env.COLLIE_OPENSSL ?? "openssl",
      ...extra,
    });
  return { runner, signature, install };
});

test("a downloaded runner signed by the release key is installed", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const release = yield* downloadable();
      yield* release.signature();

      const done = yield* release.install();

      expect(done.code).toBe(0);
      expect(yield* fs.readFile(`${root}/bin/collie`)).toEqual(release.runner);
    }),
  ));

test("an exact plain release stays selected on the next install", () =>
  runEffect(
    Effect.gen(function* () {
      const release = yield* downloadable();
      yield* release.signature();
      expect((yield* release.install({ COLLIE_VERSION: "0.2.0" })).code).toBe(0);
      expect(yield* read(`${root}/package.json`)).toContain('"version": "0.2.0"');
      expect((yield* release.install()).code).toBe(0);
      expect(yield* read(`${root}/package.json`)).toContain('"version": "0.2.0"');
    }),
  ));

test("an unavailable exact release never builds the older source", () =>
  runEffect(
    Effect.gen(function* () {
      const release = yield* downloadable();
      yield* bin.add("bun", `echo build >> '${home}/builds'; exit 0`);
      const manifest = yield* read(`${root}/package.json`);
      expect((yield* release.install({ COLLIE_VERSION: "0.2.0" })).code).not.toBe(0);
      expect(yield* exists(`${home}/builds`)).toBe(false);
      expect(yield* read(`${root}/package.json`)).toBe(manifest);
      expect(yield* read(`${root}/bin/collie`)).toBe("the runner already here");
    }),
  ));

test("a download another key signed is refused before it replaces the runner", () =>
  runEffect(
    Effect.gen(function* () {
      const release = yield* downloadable();
      yield* release.signature(p256().privateKey);

      const done = yield* release.install();

      expect(done.out).toContain("does not match its signature");
      expect(done.code).not.toBe(0);
      expect(yield* read(`${root}/bin/collie`)).toBe("the runner already here");
      expect(yield* exists(`${root}/bin/collie.new`)).toBe(false);
    }),
  ));

test("a signature that cannot be fetched leaves the runner already there", () =>
  runEffect(
    Effect.gen(function* () {
      const release = yield* downloadable();

      const done = yield* release.install();

      expect(done.out).toContain("could not fetch");
      expect(done.code).not.toBe(0);
      expect(yield* read(`${root}/bin/collie`)).toBe("the runner already here");
    }),
  ));

test("LibreSSL checks the signature as any openssl does", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const release = yield* downloadable();
      yield* release.signature();
      yield* bin.add(
        "openssl",
        `case "$1" in version) echo "LibreSSL 3.3.6" ;; *) exec ${Bun.which("openssl")} "$@" ;; esac`,
      );

      const done = yield* release.install();

      expect(done.code).toBe(0);
      expect(yield* fs.readFile(`${root}/bin/collie`)).toEqual(release.runner);
    }),
  ));

test("no openssl is named, not taken for a tampered download", () =>
  runEffect(
    Effect.gen(function* () {
      const release = yield* downloadable();
      yield* release.signature();

      const done = yield* run("install.sh", undefined, {
        COLLIE_RELEASE_BASE: `file://${home}/release`,
        COLLIE_PREPARING: "1",
        COLLIE_OPENSSL: `${home}/no-openssl-here`,
      });

      expect(done.out).toContain("no-openssl-here to check");
      expect(done.out).not.toContain("does not match");
      expect(done.out).toContain("was refused");
      expect(done.code).not.toBe(0);
      expect(yield* read(`${root}/bin/collie`)).toBe("the runner already here");
    }),
  ));

test("a linked worktree builds its runner from its own source, as any checkout does", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* remove(`${root}/.git`);
      yield* fs.writeFileString(`${root}/.git`, `gitdir: ${home}/main/.git/worktrees/collie\n`);
      yield* bin.add("curl", `echo "$*" >> "${home}/downloads"; exit 1`);

      const done = yield* prepare();

      expect(done.out).toContain("prepare: runner: done");
      expect(yield* read(`${home}/builds`)).toBe("build\n");
      expect(yield* exists(`${home}/downloads`)).toBe(false);
    }),
  ));
