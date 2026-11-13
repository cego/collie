import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { harnessLacking } from "../src/harness-held";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: "collie-harness-held-" });
  yield* fs.makeDirectory(`${repo}/bench`);
  const git = (...args: ReadonlyArray<string>) =>
    exec(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: repo });
  const write = (file: string, text: string) =>
    fs.writeFileString(`${repo}/${file}`, text).pipe(Effect.orDie);
  const head = Effect.map(git("rev-parse", "HEAD"), (out) => Str.trim(out.stdout));
  const commit = (message: string) =>
    Effect.gen(function* () {
      yield* git("add", "-A");
      yield* git("commit", "-qm", message);
      return yield* head;
    });
  yield* git("init", "-q", "-b", "main");
  yield* write("value", "10\n");
  const base = yield* commit("base");
  return { repo, git, write, commit, head, base };
});

test("a harness file whose name git quotes is lacking from a tree without it", () =>
  runEffect(
    Effect.gen(function* () {
      const { repo, write, commit, base } = yield* repository;
      yield* write("bench/é.sh", "echo 1\n");
      const harness = yield* commit("harness");
      expect(yield* harnessLacking(repo, base, [harness])).toEqual([harness]);
      expect(yield* harnessLacking(repo, harness, [harness])).toEqual([]);
    }),
  ));

test("a merge harness commit is lacking from a tree without the files it brings", () =>
  runEffect(
    Effect.gen(function* () {
      const { repo, git, write, commit, head, base } = yield* repository;
      yield* git("checkout", "-qb", "side");
      yield* write("bench/bench.sh", "echo 1\n");
      yield* commit("harness on a side branch");
      yield* git("checkout", "-q", "main");
      yield* git("merge", "-q", "--no-ff", "-m", "merge", "side");
      const merge = yield* head;
      expect(yield* harnessLacking(repo, base, [merge])).toEqual([merge]);
      expect(yield* harnessLacking(repo, merge, [merge])).toEqual([]);
    }),
  ));
