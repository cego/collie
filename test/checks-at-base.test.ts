// A start is held to the checks its base declares: `.collie/verify.json` as the ref a
// checkout for the Run is cut from has it, whatever the checkout it was started in has
// (ADR-draft-a-runs-checks-are-read-where-its-checkout-starts).

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { runDir } from "../src/engine";
import { readIntent } from "../src/intent";
import { exec } from "./support/command";
import { until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const Started = Schema.Struct({ runId: Schema.String });

const LOGGED_IN = { GITLAB_USER_LOGIN: "mk", GIT_SSH_COMMAND: "false" };
const LEFT_TO_CI = [
  { name: "check", executable: "bun", argv: ["run", "check"], cwd: "worktree", ci: "test" },
];
const REMEMBERED = [{ name: "check", executable: "bun", argv: ["run", "check"], cwd: "worktree" }];

/**
 * A checkout one commit behind origin's master, which alone has `checks` as its checks
 * file, on a remote whose remembered checks leave nothing to CI.
 */
const behind = (world: World, checks: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = (...args: ReadonlyArray<string>) =>
      exec(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
        cwd: world.project,
      });
    yield* git("symbolic-ref", "HEAD", "refs/heads/master");
    yield* git("commit", "-q", "--allow-empty", "-m", "stale");
    yield* fs.makeDirectory(`${world.project}/.collie`, { recursive: true });
    yield* fs.writeFileString(`${world.project}/.collie/verify.json`, checks);
    yield* git("add", ".collie/verify.json");
    yield* git("commit", "-q", "-m", "checks");
    yield* git("update-ref", "refs/remotes/origin/master", "HEAD");
    yield* git("reset", "-q", "--hard", "HEAD~1");
    yield* git("remote", "add", "origin", "git@gitlab.example.com:group/app.git");
    yield* fs.makeDirectory(`${world.config}/verify/gitlab.example.com/group`, {
      recursive: true,
    });
    yield* fs.writeFileString(
      `${world.config}/verify/gitlab.example.com/group/app.json`,
      asJson(REMEMBERED),
    );
  }).pipe(Effect.orDie);

const start = (
  world: World,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = LOGGED_IN,
) => collie(world, ["run", "start", ...args], env);

const checksOf = (world: World, runId: string) =>
  until(
    () => readIntent(runDir(world.state, runId)).pipe(Effect.orElseSucceed(() => null)),
    (intent) => intent !== null,
  ).pipe(Effect.map((intent) => intent!.authority.run_verification));

const runIdOf = (started: { envelope: { data?: unknown } }) =>
  flow(Schema.decodeUnknownResult(Started), Result.getOrThrow)(started.envelope.data).runId;

test(
  "a start from a checkout behind its base is held to the base's checks, not those remembered for its remote",
  () =>
    proves(
      "collie-checks-at-base-",
      (world) =>
        Effect.gen(function* () {
          yield* behind(world, asJson(LEFT_TO_CI));
          const started = yield* start(world, [
            "placed",
            "--input",
            "work=one",
            "--input",
            "ending=succeed",
          ]);
          expect(started.envelope.error).toBeUndefined();
          expect(yield* checksOf(world, runIdOf(started))).toEqual(LEFT_TO_CI);
        }),
      ["placed.workflow.ts"],
    ),
  120_000,
);

test(
  "a Run with no checkout is held to its base's checks, and the Run it starts inherits them",
  () =>
    proves(
      "collie-checks-at-base-plan-",
      (world) =>
        Effect.gen(function* () {
          yield* behind(world, asJson(LEFT_TO_CI));
          const started = yield* start(world, [
            "chains-and-opens",
            "--input",
            "mr=https://gitlab.example.com/group/app/-/merge_requests/1",
          ]);
          expect(started.envelope.error).toBeUndefined();
          const runId = runIdOf(started);
          expect(yield* checksOf(world, runId)).toEqual(LEFT_TO_CI);
          expect(yield* checksOf(world, `${runId}.build`)).toEqual(LEFT_TO_CI);
        }),
      ["chains-and-opens.workflow.ts", "opens.workflow.ts"],
    ),
  120_000,
);

test(
  "a checks file edited and not committed in the checkout a start is made from is not the Run's",
  () =>
    proves(
      "collie-checks-at-base-dirty-",
      (world) =>
        Effect.gen(function* () {
          yield* behind(world, asJson(LEFT_TO_CI));
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${world.project}/.collie`, { recursive: true });
          yield* fs.writeFileString(
            `${world.project}/.collie/verify.json`,
            asJson([{ name: "lint", executable: "true", argv: [], cwd: "worktree" }]),
          );
          const started = yield* start(world, [
            "placed",
            "--input",
            "work=one",
            "--input",
            "ending=succeed",
          ]);
          expect(started.envelope.error).toBeUndefined();
          expect(yield* checksOf(world, runIdOf(started))).toEqual(LEFT_TO_CI);
        }).pipe(Effect.orDie),
      ["placed.workflow.ts"],
    ),
  120_000,
);

for (const [whose, env] of [
  ["", LOGGED_IN],
  [", even where no login names the branch the Run would work on,", { GIT_SSH_COMMAND: "false" }],
] as const)
  test(
    `a base checks file that does not read is refused${whose} naming the ref and the file`,
    () =>
      proves(
        "collie-checks-at-base-unread-",
        (world) =>
          Effect.gen(function* () {
            yield* behind(world, '[{"name":');
            const started = yield* start(
              world,
              ["placed", "--input", "work=one", "--input", "ending=succeed"],
              env,
            );
            expect(started.envelope.error?.message).toContain(
              ".collie/verify.json at origin/master",
            );
          }),
        ["placed.workflow.ts"],
      ),
    120_000,
  );
