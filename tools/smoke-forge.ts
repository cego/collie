import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { deepStrictEqual, equal } from "node:assert/strict";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { FakeBin } from "../test/support/bin";
import { exec } from "../test/support/command";
import { runEffect } from "../test/support/effect";
import { fakeForge, serveForges } from "../test/support/forge";

const Refusal = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.Literal("needs_input"),
      details: Schema.Struct({
        inputs: Schema.Array(
          Schema.Struct({ name: Schema.String, facts: Schema.Array(Schema.String) }),
        ),
      }),
    }),
  }),
);

await runEffect(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binary = path.resolve(Bun.argv[2] ?? "bin/collie");
    const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-smoke-forge-" });
    const cwd = `${state}/repo`;
    yield* fs.makeDirectory(cwd);
    for (const argv of [
      ["git", "init", "-b", "smoke"],
      [
        "git",
        "-c",
        "user.name=Smoke",
        "-c",
        "user.email=smoke@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Smoke",
      ],
      ["git", "remote", "add", "origin", "https://github.com/smoke/repo.git"],
    ]) {
      const ran = yield* exec(argv, { cwd });
      equal(ran.exitCode, 0, ran.stderr);
    }
    const bin = yield* FakeBin.make(`${state}/bin`);
    yield* Effect.addFinalizer(() => bin.restore());
    yield* bin.add(
      "gh",
      'if [ "$*" = "auth token --hostname github.com" ]; then echo gho-fake; else exit 1; fi',
    );
    const fake = fakeForge("github", {
      installed: true,
      loggedIn: ["github.com"],
      login: "me",
      mrs: [
        {
          project: "github.com/smoke/repo",
          iid: "17",
          state: "open",
          sourceBranch: "smoke",
          head: pipe("a", Str.repeat(40)),
        },
      ],
    });
    const api = yield* serveForges({ forge: "github", face: fake.fetch });
    const ran = yield* exec([binary, "--json", "run", "start", "review"], {
      cwd,
      env: {
        ...process.env,
        HERDR_PLUGIN_ROOT: path.resolve(import.meta.dir, ".."),
        HERDR_PLUGIN_STATE_DIR: `${state}/state`,
        COLLIE_USER_DIR: `${state}/config`,
        COLLIE_CWD: cwd,
        COLLIE_FORGE_API: api,
      },
    });
    equal(ran.exitCode, 2, `${ran.stdout}\n${ran.stderr}`);
    const reply = yield* Schema.decodeEffect(Refusal)(ran.stdout).pipe(Effect.orDie);
    deepStrictEqual(
      Option.getOrUndefined(
        Arr.findFirst(reply.error.details.inputs, (one) => one.name === "target"),
      )?.facts,
      ["mr:github.com/smoke/repo#17 (branch smoke's open pull request #17)"],
      ran.stdout,
    );
    deepStrictEqual(
      Arr.map(fake.requests, (one) => [one.method, one.url, one.token]),
      [
        [
          "GET",
          "https://api.github.com/repos/smoke/repo/pulls?head=smoke%3Asmoke&state=open&per_page=100&page=1",
          "gho-fake",
        ],
      ],
    );
    yield* Console.log(
      "smoke: the compiled runner read a pull request through its lazy forge provider",
    );
  }),
);
