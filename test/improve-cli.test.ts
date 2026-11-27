import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { expect, test } from "bun:test";
import { sectionOf } from "../src/board-model";
import { connect } from "../src/host";
import { parseJson, stringifyJson } from "../src/json";
import { isSettled } from "../src/lifecycle";
import { RunRecords } from "../src/run-records";
import { OPEN_FINDINGS } from "../src/finding-status";
import { hostRecords } from "./support/records";
import { FakeBin } from "./support/bin";
import { exec } from "./support/command";
import { FORGE_HOST, PROJECT, forgeOnPath, serveForges } from "./support/forge";
import { until } from "./support/host";
import { hosted } from "./support/hosted";

const root = `${import.meta.dir}/..`;

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
});

const Findings = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({ id: Schema.String, status: Schema.String, run: Schema.NullOr(Schema.String) }),
  ),
});

const git = (args: Array<string>, cwd: string) =>
  exec(["git", "-c", "user.name=ann", "-c", "user.email=ann@example.com", ...args], { cwd });

const repository = (world: {
  readonly home: string;
  readonly project: string;
  readonly user: string;
  readonly config: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const name of yield* fs.readDirectory(`${root}/workflows`)) {
      yield* fs.copyFile(`${root}/workflows/${name}`, `${world.user}/${name}`);
    }
    yield* fs.makeDirectory(`${world.config}/personas`, { recursive: true });
    for (const name of yield* fs.readDirectory(`${root}/personas`)) {
      yield* fs.copyFile(`${root}/personas/${name}`, `${world.config}/personas/${name}`);
    }
    for (const home of [world.home, process.env.HOME ?? ""]) {
      yield* fs.makeDirectory(`${home}/.local/state/herdr/plugins/cego.collie`, {
        recursive: true,
      });
    }
    yield* git(["remote", "add", "origin", `https://${PROJECT.gitlab}.git`], world.project);
    yield* git(["commit", "-q", "--allow-empty", "-m", "start"], world.project);
    yield* git(["checkout", "-q", "-b", "feature"], world.project);
    yield* git(["push", "-q", "origin", "HEAD:refs/heads/feature"], world.project);
    yield* git(["push", "-q", "origin", "HEAD:refs/merge-requests/7/head"], world.project);
    const head = Str.trim((yield* git(["rev-parse", "HEAD"], world.project)).stdout);
    const fake = yield* FakeBin.make(`${world.home}/bin`);
    const faked = yield* forgeOnPath(fake, "gitlab", {
      installed: true,
      loggedIn: [FORGE_HOST.gitlab],
      login: "mk",
      mrs: [
        {
          project: PROJECT.gitlab,
          iid: "7",
          state: "open",
          author: "mk",
          head,
          sourceBranch: "feature",
        },
      ],
    });
    const api = yield* serveForges({ forge: "gitlab", face: faked.face });
    yield* fs.writeFileString(
      `${world.config}/config.json`,
      stringifyJson({ gitlab_host: FORGE_HOST.gitlab }),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const before = {
          api: Bun.env.COLLIE_FORGE_API,
          token: Bun.env.GITLAB_TOKEN,
          path: Bun.env.PATH,
        };
        Bun.env.COLLIE_FORGE_API = api;
        Bun.env.GITLAB_TOKEN = "test-token";
        Bun.env.PATH = `${fake.dir}:${Bun.env.PATH ?? ""}`;
        return before;
      }),
      (before) =>
        Effect.sync(() => {
          for (const [key, value] of [
            ["COLLIE_FORGE_API", before.api],
            ["GITLAB_TOKEN", before.token],
            ["PATH", before.path],
          ] as const) {
            if (value === undefined) {
              delete Bun.env[key];
            } else {
              Bun.env[key] = value;
            }
          }
        }),
    );
  });

test("the CLI takes Improve over two findings of a review, and dismissing the last empties its open count", () =>
  hosted(
    "hw-improve-cli-",
    ({ world }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository(world);
        yield* fs.writeFileString(
          `${world.home}/outputs.json`,
          stringifyJson([
            {
              verdict: "findings",
              summary: "It guards the input.",
              findings: [
                { severity: "major", file: "src/a.ts", title: "the guard" },
                { severity: "major", file: "src/b.ts", title: "the retry" },
                { severity: "minor", file: "src/c.ts", title: "the name" },
              ],
              dropped: [],
              fixed: [],
            },
          ]),
        );
        const run = (args: Array<string>) =>
          exec([process.execPath, `${root}/src/main.ts`, ...args], {
            cwd: root,
            env: {
              COLLIE_ROOT: root,
              COLLIE_STATE_DIR: world.state,
              COLLIE_USER_DIR: world.config,
              HOME: world.home,
              PWD: root,
            },
          });
        const json = (args: Array<string>) =>
          Effect.gen(function* () {
            const answered = yield* run(["--json", ...args]);
            const envelope = parseJson(Envelope, answered.stdout);
            if (!envelope.ok) {
              return yield* Effect.die(
                `collie ${Arr.join(args, " ")} refused: ${envelope.error?.message ?? ""}`,
              );
            }
            return envelope.data;
          });
        const findings = (runId: string) =>
          Effect.flatMap(json(["run", "findings", runId]), (data) =>
            Effect.map(Schema.decodeUnknownEffect(Findings)(data), (decoded) => decoded.findings),
          );
        const card = (runId: string) =>
          Effect.gen(function* () {
            const client = yield* connect(world.state).pipe(Effect.orDie);
            const sent = yield* client.board().pipe(Stream.runHead, Effect.orDie);
            const board = Option.getOrUndefined(sent);
            const found = Option.getOrUndefined(
              Arr.findFirst(
                board?._tag === "Snapshot" ? board.tasks : [],
                (one) => one.run === runId,
              ),
            );
            if (found === undefined) {
              return yield* Effect.die(`no card for ${runId}`);
            }
            return {
              section: sectionOf(found),
              landed: found.landed,
            };
          });

        const openCount = (runId: string) =>
          hostRecords(
            world.state,
            RunRecords.use((records) => records.fact(runId, OPEN_FINDINGS)),
          ).pipe(Effect.map(Number));
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            id: "review",
            request: "review-the-branch",
            input: {
              target: `https://${PROJECT.gitlab}/-/merge_requests/7`,
              plan: "",
              proves: "",
            },
          })
          .pipe(Effect.orDie);
        for (let round = 0; round < 4; round += 1) {
          const seen = yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (one) =>
              one !== null &&
              (isSettled(one) || Arr.some(one.waiting, (one) => one.answer === null)),
          );
          if (seen === null || isSettled(seen)) {
            break;
          }
          const decision = Arr.findFirst(seen.waiting, (one) => one.answer === null);
          if (Option.isNone(decision)) {
            break;
          }
          const keep = Option.getOrUndefined(
            Arr.findFirst(decision.value.options, (one) => Str.startsWith("Don")(one.title)),
          );
          yield* client
            .answer({
              runId: started.runId,
              decision: decision.value.name,
              value: (keep ?? decision.value.options[0])?.title ?? "",
              request: `answer-${round}`,
            })
            .pipe(Effect.orDie);
        }
        yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (one) => one !== null && isSettled(one),
        );

        const ids: [string, string, string] = [
          `${started.runId}-F1`,
          `${started.runId}-F2`,
          `${started.runId}-F3`,
        ];
        const [first, second, third] = ids;
        expect(Arr.map(yield* findings(started.runId), (one) => [one.id, one.status])).toEqual([
          [first, "open"],
          [second, "open"],
          [third, "open"],
        ]);
        expect(yield* card(started.runId)).toEqual({ section: "waiting", landed: false });

        const chosen = yield* json([
          "run",
          "action",
          started.runId,
          "improve",
          "--input",
          `findings=${first}, ${second}`,
          "--request-id",
          "choose-two",
        ]);
        const child = yield* Schema.decodeUnknownEffect(Schema.Struct({ run: Schema.String }))(
          chosen,
        ).pipe(Effect.map((row) => row.run));
        expect(
          Arr.map(yield* findings(started.runId), (one) => [one.id, one.status, one.run]),
        ).toEqual([
          [first, "taken", child],
          [second, "taken", child],
          [third, "open", null],
        ]);
        const prompt = yield* until(
          () =>
            fs
              .readFileString(`${world.state}/agents/${child}/fix.prompt.md`)
              .pipe(Effect.orElseSucceed(() => "")),
          (text) => text !== "",
        );
        expect(prompt).toContain("the guard");
        expect(prompt).toContain("the retry");
        expect(prompt).not.toContain("the name");
        expect(yield* card(started.runId)).toEqual({ section: "waiting", landed: false });

        yield* json([
          "run",
          "disposition",
          started.runId,
          "--as",
          "merged",
          "--ref",
          `mr:${PROJECT.gitlab}!7`,
          "--request-id",
          "landed",
        ]);
        expect(yield* card(started.runId)).toEqual({ section: "waiting", landed: false });
        yield* json([
          "run",
          "finding",
          started.runId,
          third,
          "--dismiss",
          "not worth it",
          "--request-id",
          "dismiss-third",
        ]);
        expect(Arr.map(yield* findings(started.runId), (one) => [one.id, one.status])).toEqual([
          [first, "taken"],
          [second, "taken"],
          [third, "dismissed"],
        ]);
        expect(yield* openCount(started.runId)).toBe(0);
        expect(yield* card(started.runId)).toEqual({ section: "finished", landed: true });
      }),
    [],
  ));
