import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import type { Runner } from "../src/mr";
import {
  fastForward,
  readProduction,
  readTag,
  SavedAlignmentSchema,
  savedHead,
  savedRefusalWhy,
  stackOrder,
} from "../src/releasing";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { FORGE_HOST, PROJECT, fakeForge } from "./support/forge";
import type { ForgeModel } from "./support/forge";

const REF = { project: PROJECT.gitlab, iid: "30" };
const PIPELINE = `https://${PROJECT.gitlab}/-/pipelines/7`;

const git = (cwd: string, ...args: Array<string>) =>
  Effect.gen(function* () {
    const ran = yield* exec(["git", ...args], { cwd });
    if (ran.exitCode !== 0) {
      throw new Error(`git ${Arr.join(args, " ")}: ${ran.stderr}`);
    }
    return Str.trim(ran.stdout);
  });

const runner: (forge?: Runner<never>) => Runner<never> =
  (forge = () => Effect.succeed({ code: 1, stdout: "" })) =>
  (cmd, args, cwd) =>
    cmd === "git"
      ? Effect.map(exec([cmd, ...args], { cwd }), (ran) => ({
          code: ran.exitCode,
          stdout: ran.stdout,
          stderr: ran.stderr,
        }))
      : forge(cmd, args, cwd);

const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-releasing-" });
  const origin = `${root}/origin.git`;
  const cwd = `${root}/checkout`;
  yield* git(root, "init", "-q", "--bare", "-b", "main", origin);
  yield* git(root, "clone", "-q", origin, cwd);
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ] as const) {
    yield* git(cwd, "config", key, value);
  }
  const commit = (file: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(`${cwd}/${file}`, file);
      yield* git(cwd, "add", file);
      yield* git(cwd, "commit", "-q", "-m", file);
      yield* git(cwd, "push", "-q", "origin", "HEAD:main");
      return yield* git(cwd, "rev-parse", "HEAD");
    });
  const first = yield* commit("one.ts");
  const tag = (name: string, force = false) =>
    Effect.gen(function* () {
      yield* git(cwd, "tag", ...(force ? ["-f"] : []), "-a", name, "-m", name);
      yield* git(cwd, "push", "-q", ...(force ? ["-f"] : []), "origin", `refs/tags/${name}`);
      return yield* git(cwd, "rev-parse", "HEAD");
    });
  return { fs, root, cwd, commit, first, tag };
});

test("an alignment a Release saved as a bare head before the refusal carried a cause still reads as a head", () =>
  runEffect(
    Effect.gen(function* () {
      const saved = yield* Schema.decodeEffect(SavedAlignmentSchema)("a1b2c3d4");
      expect(savedHead(saved)).toBe("a1b2c3d4");
      expect(savedRefusalWhy(saved)).toBeNull();
      const refused = yield* Schema.decodeEffect(SavedAlignmentSchema)({
        _tag: "Refused",
        why: "the checkout has uncommitted changes",
        cause: "checkout-dirty-collie",
      });
      expect(savedHead(refused)).toBeNull();
      expect(savedRefusalWhy(refused)).toBe("the checkout has uncommitted changes");
    }),
  ));

test("a checkout with uncommitted changes is refused even where it is already at the head", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      yield* fs.writeFileString(`${cwd}/one.ts`, "an uncommitted fix");
      const moved = yield* fastForward({ runDir: `${root}/run`, cwd, head: first, run: runner() });
      expect(moved._tag).toBe("Refused");
    }).pipe(Effect.scoped),
  ));

for (const detached of [false, true]) {
  test(`a ${detached ? "detached checkout" : "different branch"} is refused at the requested head when a source branch is required`, () =>
    runEffect(
      Effect.gen(function* () {
        const { root, cwd, first } = yield* repository;
        yield* git(cwd, "checkout", "-q", ...(detached ? ["--detach", first] : ["-b", "other"]));
        const moved = yield* fastForward({
          runDir: `${root}/run`,
          cwd,
          head: first,
          branch: "main",
          run: runner(),
        });
        expect(moved._tag).toBe("Refused");
        if (moved._tag === "Refused") {
          expect(moved.why).toContain("source branch main");
        }
        expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(first);
      }).pipe(Effect.scoped),
    ));
}

test("a plain push past the journaled head is not refused; the checkout is taken at its real tip", () =>
  runEffect(
    Effect.gen(function* () {
      const { root, cwd, commit, first } = yield* repository;
      const second = yield* commit("two.ts");
      const third = yield* commit("three.ts");
      expect(second).not.toBe(first);
      expect(third).not.toBe(second);
      // WARNING: a replayed head the checkout no longer carries is answered At, not refused as after a force push.
      const moved = yield* fastForward({ runDir: `${root}/run`, cwd, head: first, run: runner() });
      expect(moved._tag).toBe("At");
      if (moved._tag === "At") {
        expect(moved.head).toBe(third);
        expect(moved.from).toBe(third);
      }
    }).pipe(Effect.scoped),
  ));

// WARNING: a target that does not carry `onto` is what makes the new head a rebase rather than a descent from it.
const rebaseOnto = (cwd: string, onto: string, target: string) =>
  Effect.gen(function* () {
    const tree = yield* git(cwd, "rev-parse", `${onto}^{tree}`);
    const rebased = yield* git(
      cwd,
      "commit-tree",
      tree,
      "-p",
      target,
      "-m",
      "rebased onto the target",
    );
    yield* git(cwd, "push", "-q", "--force", "origin", `${rebased}:refs/heads/main`);
    return rebased;
  });

const newerTarget = (cwd: string) =>
  Effect.gen(function* () {
    const tree = yield* git(cwd, "rev-parse", "HEAD^{tree}");
    const target = yield* git(cwd, "commit-tree", tree, "-m", "the newer target");
    yield* git(cwd, "push", "-q", "--force", "origin", `${target}:refs/heads/main`);
    return target;
  });

test("a clean checkout at a published head is reset to the head the forge moved to, as after a rebase", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      const target = yield* newerTarget(cwd);
      const rebased = yield* rebaseOnto(cwd, first, target);
      yield* git(cwd, "reset", "-q", "--hard", first);
      const moved = yield* fastForward({
        runDir: `${root}/run`,
        cwd,
        head: rebased,
        run: runner(),
      });
      expect(moved._tag).toBe("At");
      if (moved._tag === "At") {
        expect(moved.head).toBe(rebased);
        expect(moved.from).toBe(first);
      }
      expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(rebased);
      const log = yield* fs.readFileString(`${root}/run/log.txt`);
      expect(log).toContain(
        `moved the checkout from ${first} to ${rebased}, which origin's main no longer carries`,
      );
    }).pipe(Effect.scoped),
  ));

test("a checkout holding a commit origin never had is refused with its cause, naming the commit and leaving it", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      const target = yield* newerTarget(cwd);
      const rebased = yield* rebaseOnto(cwd, first, target);
      yield* git(cwd, "reset", "-q", "--hard", first);
      yield* fs.writeFileString(`${cwd}/local.ts`, "local");
      yield* git(cwd, "add", "local.ts");
      yield* git(cwd, "commit", "-q", "-m", "a local fix origin never had");
      const local = yield* git(cwd, "rev-parse", "HEAD");
      const moved = yield* fastForward({
        runDir: `${root}/run`,
        cwd,
        head: rebased,
        run: runner(),
      });
      expect(moved._tag).toBe("Refused");
      if (moved._tag === "Refused") {
        expect(moved.cause).toBe("branch-force-pushed");
        expect(moved.why).toContain(pipe_(local, Str.slice(0, 8)));
        expect(moved.why).toContain("a local fix origin never had");
      }
      expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(local);
    }).pipe(Effect.scoped),
  ));

test("a reset that would overwrite a file the checkout keeps out of git is refused, naming it", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      yield* fs.writeFileString(`${cwd}/.gitignore`, "local.env\n");
      yield* git(cwd, "add", ".gitignore");
      yield* git(cwd, "commit", "-q", "-m", "keep local.env out of git");
      yield* git(cwd, "push", "-q", "origin", "HEAD:main");
      const base = yield* git(cwd, "rev-parse", "HEAD");
      expect(base).not.toBe(first);
      yield* fs.writeFileString(`${cwd}/local.env`, "the forge's");
      yield* git(cwd, "add", "-f", "local.env");
      yield* git(cwd, "commit", "-q", "-m", "track local.env");
      const tracked = yield* git(cwd, "rev-parse", "HEAD");
      const target = yield* newerTarget(cwd);
      const tree = yield* git(cwd, "rev-parse", `${tracked}^{tree}`);
      const rebased = yield* git(cwd, "commit-tree", tree, "-p", target, "-m", "the forge's head");
      yield* git(cwd, "push", "-q", "-f", "origin", `${rebased}:refs/heads/main`);
      yield* git(cwd, "reset", "-q", "--hard", base);
      yield* fs.writeFileString(`${cwd}/local.env`, "the local one");
      const moved = yield* fastForward({
        runDir: `${root}/run`,
        cwd,
        head: rebased,
        run: runner(),
      });
      expect(moved._tag).toBe("Refused");
      if (moved._tag === "Refused") {
        expect(moved.cause).toBe("branch-force-pushed");
        expect(moved.why).toContain("local.env");
      }
      expect(yield* fs.readFileString(`${cwd}/local.env`)).toBe("the local one");
      expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(base);
    }).pipe(Effect.scoped),
  ));

test("a checkout carrying a commit origin has moved past is taken as it is, not reported as unpushed", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first, commit } = yield* repository;
      const carried = yield* commit("two.ts");
      yield* commit("three.ts");
      yield* git(cwd, "reset", "-q", "--hard", carried);
      const moved = yield* fastForward({
        runDir: `${root}/run`,
        cwd,
        head: first,
        run: runner(),
      });
      expect(moved._tag).toBe("At");
      if (moved._tag === "At") {
        expect(moved.head).toBe(carried);
        expect(moved.from).toBe(carried);
      }
      expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(carried);
      const log = yield* fs.readFileString(`${root}/run/log.txt`);
      expect(log).toContain(
        `the checkout already carries ${pipe_(first, Str.slice(0, 8))} and sits at ${pipe_(carried, Str.slice(0, 8))}, which origin's main carries`,
      );
    }).pipe(Effect.scoped),
  ));

test("a reset that would write a file over a directory the checkout keeps out of git is refused, naming what it holds", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      yield* fs.writeFileString(`${cwd}/.git/info/exclude`, "local/\n");
      yield* fs.makeDirectory(`${cwd}/local`, { recursive: true });
      yield* fs.writeFileString(`${cwd}/local/settings`, "the local one");
      const target = yield* newerTarget(cwd);
      const forge = `${root}/forge`;
      yield* git(root, "clone", "-q", `${root}/origin.git`, forge);
      for (const [key, value] of [
        ["user.name", "Test"],
        ["user.email", "test@example.com"],
        ["commit.gpgsign", "false"],
      ] as const) {
        yield* git(forge, "config", key, value);
      }
      yield* git(forge, "reset", "-q", "--hard", target);
      yield* fs.writeFileString(`${forge}/local`, "the forge's");
      yield* git(forge, "add", "-f", "local");
      yield* git(forge, "commit", "-q", "-m", "track a file named local");
      const incoming = yield* git(forge, "rev-parse", "HEAD");
      yield* git(forge, "push", "-q", "-f", "origin", `${incoming}:refs/heads/main`);
      expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(first);
      const moved = yield* fastForward({
        runDir: `${root}/run`,
        cwd,
        head: incoming,
        run: runner(),
      });
      expect(moved._tag).toBe("Refused");
      if (moved._tag === "Refused") {
        expect(moved.cause).toBe("branch-force-pushed");
        expect(moved.why).toContain("local/settings");
      }
      expect(yield* fs.readFileString(`${cwd}/local/settings`)).toBe("the local one");
      expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(first);
    }).pipe(Effect.scoped),
  ));

test("a checkout ahead of a cached origin tip is refused once origin's branch is gone", () =>
  runEffect(
    Effect.gen(function* () {
      const { root, cwd, first } = yield* repository;
      yield* git(cwd, "checkout", "-q", "-b", "feature");
      yield* (yield* FileSystem.FileSystem).writeFileString(`${cwd}/two.ts`, "two");
      yield* git(cwd, "add", "two.ts");
      yield* git(cwd, "commit", "-q", "-m", "two.ts");
      yield* git(cwd, "push", "-q", "origin", "HEAD:refs/heads/feature");
      const carried = yield* git(cwd, "rev-parse", "HEAD");
      yield* git(root, "--git-dir", `${root}/origin.git`, "update-ref", "-d", "refs/heads/feature");
      const moved = yield* fastForward({
        runDir: `${root}/run`,
        cwd,
        head: first,
        run: runner(),
      });
      expect(moved._tag).toBe("Refused");
      if (moved._tag === "Refused") {
        expect(moved.cause).toBe("checkout-dirty-human");
        expect(moved.why).toContain("ahead of origin's feature");
      }
      expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(carried);
    }).pipe(Effect.scoped),
  ));

test("a force-push refusal names every unpublished commit, past the tenth", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      const target = yield* newerTarget(cwd);
      const rebased = yield* rebaseOnto(cwd, first, target);
      yield* git(cwd, "reset", "-q", "--hard", first);
      const locals: Array<string> = [];
      for (let n = 0; n < 12; n++) {
        yield* fs.writeFileString(`${cwd}/local-${n}.ts`, `local ${n}`);
        yield* git(cwd, "add", `local-${n}.ts`);
        yield* git(cwd, "commit", "-q", "-m", `a local fix ${n}`);
        locals.push(yield* git(cwd, "rev-parse", "HEAD"));
      }
      const moved = yield* fastForward({
        runDir: `${root}/run`,
        cwd,
        head: rebased,
        run: runner(),
      });
      expect(moved._tag).toBe("Refused");
      if (moved._tag === "Refused") {
        expect(moved.cause).toBe("branch-force-pushed");
        for (const local of locals) {
          expect(moved.why).toContain(pipe_(local, Str.slice(0, 8)));
        }
      }
      expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(locals.at(-1)!);
    }).pipe(Effect.scoped),
  ));

test("a head this Run recorded is published even where origin's reflog never carried it, so the checkout is reset", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      const runDir = `${root}/run`;
      const recorded = yield* fastForward({ runDir, cwd, head: first, run: runner() });
      expect(recorded._tag).toBe("At");
      yield* git(cwd, "reflog", "expire", "--expire=now", "--all");
      const target = yield* newerTarget(cwd);
      const rebased = yield* rebaseOnto(cwd, first, target);
      yield* git(cwd, "reset", "-q", "--hard", first);
      const moved = yield* fastForward({ runDir, cwd, head: rebased, run: runner() });
      expect(moved._tag).toBe("At");
      if (moved._tag === "At") {
        expect(moved.head).toBe(rebased);
        expect(moved.from).toBe(first);
      }
      const log = yield* fs.readFileString(`${runDir}/log.txt`);
      expect(log).toContain(
        `moved the checkout from ${first} to ${rebased}, which origin's main no longer carries`,
      );
    }).pipe(Effect.scoped),
  ));

const aheadByOne = (cwd: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${cwd}/${file}`, file);
    yield* git(cwd, "add", file);
    yield* git(cwd, "commit", "-q", "-m", file);
    return yield* git(cwd, "rev-parse", "HEAD");
  });

for (const createdByCollie of [true, false]) {
  const cause = createdByCollie ? "checkout-dirty-collie" : "checkout-dirty-human";
  const whose = createdByCollie ? "a Collie worktree" : "a plain checkout";

  test(`${whose} with an uncommitted file is refused under ${cause}, naming the file`, () =>
    runEffect(
      Effect.gen(function* () {
        const { fs, root, cwd, first } = yield* repository;
        yield* fs.writeFileString(`${cwd}/uncommitted.ts`, "work in progress");
        const moved = yield* fastForward({
          runDir: `${root}/run`,
          cwd,
          head: first,
          createdByCollie,
          run: runner(),
        });
        expect(moved._tag).toBe("Refused");
        if (moved._tag === "Refused") {
          expect(moved.cause).toBe(cause);
          expect(moved.why).toContain("uncommitted.ts");
        }
        expect(yield* git(cwd, "status", "--porcelain")).toBe("?? uncommitted.ts");
      }).pipe(Effect.scoped),
    ));

  test(`${whose} one unpushed commit ahead of the requested head is refused under ${cause}, naming the commit`, () =>
    runEffect(
      Effect.gen(function* () {
        const { root, cwd, first } = yield* repository;
        const local = yield* aheadByOne(cwd, "a-local-fix.ts");
        expect(local).not.toBe(first);
        const moved = yield* fastForward({
          runDir: `${root}/run`,
          cwd,
          head: first,
          createdByCollie,
          run: runner(),
        });
        expect(moved._tag).toBe("Refused");
        if (moved._tag === "Refused") {
          expect(moved.cause).toBe(cause);
          expect(moved.why).toContain(pipe_(local, Str.slice(0, 8)));
          expect(moved.why).toContain("a-local-fix.ts");
        }
        expect(yield* git(cwd, "rev-parse", "HEAD")).toBe(local);
      }).pipe(Effect.scoped),
    ));
}

const onGitlab = (runs: ForgeModel["runs"], over: Partial<ForgeModel> = {}) => {
  const fake = fakeForge("gitlab", {
    installed: true,
    loggedIn: [FORGE_HOST.gitlab],
    login: "me",
    mrs: [],
    runs,
    ...over,
  });
  return { run: runner(fake.run), layer: fake.layer };
};

const tagRun = (sha: string, over: Partial<NonNullable<ForgeModel["runs"]>[string]> = {}) => ({
  status: "success",
  ref: "v1.2.0",
  sha,
  jobs: [{ name: "publish", state: "passed" as const }],
  ...over,
});

test("a package's tag is proved only by a pipeline of its own project, tag and commit", () =>
  runEffect(
    Effect.gen(function* () {
      const { cwd, first, tag } = yield* repository;
      const at = yield* tag("v1.2.0");
      const read = (pipeline: string | null, runs: ForgeModel["runs"]) => {
        const fake = onGitlab(runs);
        return readTag({
          cwd,
          tag: "v1.2.0",
          merged: first,
          pipeline,
          proves: "finished",
          ref: REF,
          stage: [],
          production: [],
          run: fake.run,
        }).pipe(Effect.provide(fake.layer));
      };
      expect((yield* read(PIPELINE, { "7": tagRun(at) }))._tag).toBe("Proved");
      const elsewhere = pipe_(PIPELINE, Str.replace("group/app", "other/project"));
      expect((yield* read(elsewhere, { "7": tagRun(at) }))._tag).toBe("Unproved");
      expect((yield* read(PIPELINE, { "7": tagRun(at, { ref: "main" }) }))._tag).toBe("Unproved");
      expect((yield* read(PIPELINE, { "7": tagRun("0ld") }))._tag).toBe("Unproved");
    }).pipe(Effect.scoped),
  ));

test("a package's tag named with no pipeline is proved by the forge showing none, or by the one it shows", () =>
  runEffect(
    Effect.gen(function* () {
      const { cwd, first, tag } = yield* repository;
      const at = yield* tag("v1.2.0");
      const read = (runs: ForgeModel["runs"]) => {
        const fake = onGitlab(runs);
        return readTag({
          cwd,
          tag: "v1.2.0",
          merged: first,
          pipeline: null,
          proves: "finished",
          ref: REF,
          stage: [],
          production: [],
          run: fake.run,
        }).pipe(Effect.provide(fake.layer));
      };
      expect((yield* read({}))._tag).toBe("Proved");
      expect((yield* read({ "7": tagRun(at) }))._tag).toBe("Proved");
      expect((yield* read({ "7": tagRun(at, { status: "failed" }) }))._tag).toBe("Unproved");
    }).pipe(Effect.scoped),
  ));

test("an application's tag is not ready for production on a pipeline of another project", () =>
  runEffect(
    Effect.gen(function* () {
      const { cwd, first, tag } = yield* repository;
      const at = yield* tag("v1.2.0");
      const runs = { "7": tagRun(at, { jobs: [{ name: "deploy-production", state: "manual" }] }) };
      const fake = onGitlab(runs);
      const read = (pipeline: string) =>
        readTag({
          cwd,
          tag: "v1.2.0",
          merged: first,
          pipeline,
          proves: "staged",
          ref: REF,
          stage: [],
          production: ["deploy-production"],
          run: fake.run,
        }).pipe(Effect.provide(fake.layer));
      expect((yield* read(PIPELINE))._tag).toBe("Proved");
      expect((yield* read(pipe_(PIPELINE, Str.replace("group/app", "other/project"))))._tag).toBe(
        "Unproved",
      );
    }).pipe(Effect.scoped),
  ));

test("a job still running, pending or waiting by hand keeps an application's tag from production, before and at the go", () =>
  runEffect(
    Effect.gen(function* () {
      const { cwd, first, tag } = yield* repository;
      const at = yield* tag("v1.2.0");
      const object = yield* git(cwd, "rev-parse", "refs/tags/v1.2.0");
      for (const state of ["running", "pending", "manual"] as const) {
        const fake = onGitlab({
          "7": tagRun(at, {
            jobs: [
              { name: "test", state },
              { name: "deploy-production", state: "manual" },
            ],
          }),
        });
        const proved = yield* readTag({
          cwd,
          tag: "v1.2.0",
          merged: first,
          pipeline: PIPELINE,
          proves: "staged",
          ref: REF,
          stage: [],
          production: ["deploy-production"],
          run: fake.run,
        }).pipe(Effect.provide(fake.layer));
        expect(proved._tag).toBe("Unproved");
        const played = yield* readProduction({
          cwd,
          ref: REF,
          tag: "v1.2.0",
          at: object,
          merged: first,
          pipeline: PIPELINE,
          jobs: ["deploy-production"],
          run: fake.run,
        }).pipe(Effect.provide(fake.layer));
        expect(played._tag).toBe("Unproved");
      }
    }).pipe(Effect.scoped),
  ));

test("a tag moved after its proof plays nothing in production, even onto a descendant with its own pipeline", () =>
  runEffect(
    Effect.gen(function* () {
      const { cwd, first, commit, tag } = yield* repository;
      const at = yield* tag("v1.2.0");
      const jobs = [{ name: "deploy-production", state: "manual" as const }];
      const fake = onGitlab({ "7": tagRun(at, { jobs }) });
      const proved = yield* readTag({
        cwd,
        tag: "v1.2.0",
        merged: first,
        pipeline: PIPELINE,
        proves: "staged",
        ref: REF,
        stage: [],
        production: ["deploy-production"],
        run: fake.run,
      }).pipe(Effect.provide(fake.layer));
      if (proved._tag !== "Proved") {
        throw new Error(`not proved: ${proved._tag}`);
      }
      const read = (sha: string) => {
        const fake = onGitlab({ "7": tagRun(sha, { jobs }) });
        return readProduction({
          cwd,
          ref: REF,
          tag: "v1.2.0",
          at: proved.at,
          merged: first,
          pipeline: PIPELINE,
          jobs: ["deploy-production"],
          run: fake.run,
        }).pipe(Effect.provide(fake.layer));
      };
      expect((yield* read(at))._tag).toBe("Play");
      const later = yield* commit("two.ts");
      yield* tag("v1.2.0", true);
      expect((yield* read(later))._tag).toBe("Unproved");
    }).pipe(Effect.scoped),
  ));

test("a set is released blockers first: one targeting another's branch waits on it, the rest keep their order", () => {
  const app = "gitlab.example.com/group/app!12";
  const api = "gitlab.example.com/group/api!7";
  const web = "gitlab.example.com/group/web!3";
  expect(
    stackOrder([
      { id: api, source: "api-schema", target: "app-schema" },
      { id: app, source: "app-schema", target: "main" },
      { id: web, source: "web-page", target: "main" },
    ]),
  ).toEqual({
    _tag: "Ordered",
    order: [
      { id: app, waitsOn: [] },
      { id: web, waitsOn: [] },
      { id: api, waitsOn: [app] },
    ],
  });
});

test("a set follows its plan's waves too: a Change of a later wave waits on the set's Changes of earlier ones", () => {
  const app = "gitlab.example.com/group/app!12";
  const api = "gitlab.example.com/group/api!7";
  const web = "gitlab.example.com/group/web!3";
  const other = "gitlab.example.com/group/cli!4";
  expect(
    stackOrder([
      { id: api, source: "plan", target: "main", wave: { plan: "r-fan", at: 1 } },
      { id: app, source: "plan", target: "main", wave: { plan: "r-fan", at: 0 } },
      { id: web, source: "plan", target: "main", wave: { plan: "r-fan", at: 1 } },
      { id: other, source: "cli-fix", target: "main", wave: { plan: "r-other", at: 3 } },
    ]),
  ).toEqual({
    _tag: "Ordered",
    order: [
      { id: app, waitsOn: [] },
      { id: other, waitsOn: [] },
      { id: api, waitsOn: [app] },
      { id: web, waitsOn: [app] },
    ],
  });
});

test("a set whose merge requests target each other's branches is a cycle, naming each", () => {
  const app = "gitlab.example.com/group/app!12";
  const api = "gitlab.example.com/group/app!7";
  expect(
    stackOrder([
      { id: app, source: "one", target: "two" },
      { id: api, source: "two", target: "one" },
      { id: "gitlab.example.com/group/web!3", source: "three", target: "main" },
    ]),
  ).toEqual({ _tag: "Cycle", ids: [app, api] });
});
