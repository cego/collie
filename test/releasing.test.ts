// What a Release Run has the host prove: its checkout at the merge request's head, its tag
// on origin and the tag's pipeline, read from git and the forge rather than an Output.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import type { Runner } from "../src/mr";
import { fastForward, readProduction, readTag } from "../src/releasing";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { FORGE_HOST, PROJECT, fakeForge, type ForgeModel } from "./support/forge";

const REF = { project: PROJECT.gitlab, iid: "30" };
const PIPELINE = `https://${PROJECT.gitlab}/-/pipelines/7`;

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const ran = yield* exec(["git", ...args], { cwd });
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
    return ran.stdout.trim();
  });

/** git for real; any other command is the forge's, answered by `forge`. */
const runner =
  (forge: Runner<never> = () => Effect.succeed({ code: 1, stdout: "" })): Runner<never> =>
  (cmd, args, cwd) =>
    cmd === "git"
      ? Effect.map(exec([cmd, ...args], { cwd }), (ran) => ({
          code: ran.exitCode,
          stdout: ran.stdout,
          stderr: ran.stderr,
        }))
      : forge(cmd, args, cwd);

/** A bare origin and a checkout of it with one commit pushed. */
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
  ] as const)
    yield* git(cwd, "config", key, value);
  const commit = (file: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(`${cwd}/${file}`, file);
      yield* git(cwd, "add", file);
      yield* git(cwd, "commit", "-q", "-m", file);
      yield* git(cwd, "push", "-q", "origin", "HEAD:main");
      return yield* git(cwd, "rev-parse", "HEAD");
    });
  const first = yield* commit("one.ts");
  /** Tags HEAD, annotated, and pushes the tag; gives back the commit it tags. */
  const tag = (name: string, force = false) =>
    Effect.gen(function* () {
      yield* git(cwd, "tag", ...(force ? ["-f"] : []), "-a", name, "-m", name);
      yield* git(cwd, "push", "-q", ...(force ? ["-f"] : []), "origin", `refs/tags/${name}`);
      return yield* git(cwd, "rev-parse", "HEAD");
    });
  return { fs, root, cwd, commit, first, tag };
});

test("a checkout with uncommitted changes is refused even where it is already at the head", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      yield* fs.writeFileString(`${cwd}/one.ts`, "an uncommitted fix");
      const moved = yield* fastForward({ runDir: `${root}/run`, cwd, head: first, run: runner() });
      expect(moved._tag).toBe("Refused");
    }).pipe(Effect.scoped),
  ));

/** GitLab answering `runs`, and git for real. */
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
      const elsewhere = PIPELINE.replace("group/app", "other/project");
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
      expect((yield* read(PIPELINE.replace("group/app", "other/project")))._tag).toBe("Unproved");
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
      if (proved._tag !== "Proved") throw new Error(`not proved: ${proved._tag}`);
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
