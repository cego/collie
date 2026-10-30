// A credential a human or an agent pastes into a goal, a steer or an answer is replaced by
// its kind before the host writes or forwards anything, and the operation still happens.
// The values here are built at runtime, synthetic, and only shaped like credentials.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { connect } from "../src/host";
import { readEnv } from "../src/env";
import { resetExecutors } from "../src/executors";
import { isSettled } from "../src/lifecycle";
import { carryOutAsked } from "../src/run-actions";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";
import { hosted, hostedRun } from "./support/hosted";
import { readIntent } from "../src/intent";
import { runDir } from "../src/engine";
import { removedNotice } from "../src/redact";
import { until } from "./support/host";

const GITLAB = Arr.join(["glpat", "synthetic0000000000test"], "-");
const GITHUB = Arr.join(["ghp", "Synthetic0000000000000000000000000Test"], "_");
const AWS = Arr.join(["AKIA", "SYNTHETIC0000TST"], "");

/** Every file under `dir` that holds `value`. */
const holding = (dir: string, values: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found: string[] = [];
    const walk = (at: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        for (const name of yield* fs.readDirectory(at).pipe(Effect.orElseSucceed(() => []))) {
          const file = path.join(at, name);
          const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null));
          if (info?.type === "Directory") yield* walk(file);
          else if (info?.type === "File") {
            const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
            for (const value of values)
              if (pipe_(text, Str.includes(value))) found.push(`${file}: ${value}`);
          }
        }
      });
    yield* walk(dir);
    return found;
  });

test(
  "a start, a steer, a goal and an answer carrying credentials are carried out without them",
  () =>
    hosted("collie-credentials-", ({ world }) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            id: "proof",
            request: "start",
            input: { note: `deploy with ${GITLAB}` },
          })
          .pipe(Effect.orDie);
        expect(started.redacted).toEqual(["<gitlab token>"]);
        const { runId } = started;
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => (view?.waiting.length ?? 0) > 0,
        );

        const steered = yield* client
          .steer({ runId, text: `the token is ${GITHUB}`, request: "steer" })
          .pipe(Effect.orDie);
        expect(steered.redacted).toEqual(["<github token>"]);

        const goal = yield* client
          .changeIntent({
            runId,
            change: { kind: "set-goal", goal: `ship it, AWS key ${AWS}` },
            propagate: false,
            request: "goal",
          })
          .pipe(Effect.orDie);
        expect(goal.redacted).toEqual(["<aws key id>"]);
        expect((yield* readIntent(runDir(world.state, runId)))?.goal).toBe(
          "ship it, AWS key <aws key id>",
        );

        const answered = yield* client
          .answer({ runId, decision: "decision", value: `use ${GITLAB}`, request: "answer" })
          .pipe(Effect.orDie);
        expect(answered.redacted).toEqual(["<gitlab token>"]);
        expect(answered.value).toBe("use <gitlab token>");
        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status).toMatchObject({ value: expect.stringContaining("<gitlab token>") });

        expect(yield* holding(world.state, [GITLAB, GITHUB, AWS])).toEqual([]);
      }),
    ),
  120_000,
);

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const FakeState = Schema.fromJsonString(
  Schema.Struct({ agents: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);

test(
  "an agent's prompt, a delivery to it and everything sent to herdr carry the kind, never the value",
  () =>
    proves(
      "collie-credentials-agent-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encode([{ verdict: "built" }])).pipe(Effect.orDie);
          const set = {
            FAKE_HERDR_OUTPUTS: outputs,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const before = Rec.fromEntries(
                Arr.map(Rec.keys(set), (key) => [key, Bun.env[key]] as const),
              );
              Object.assign(Bun.env, set);
              return before;
            }),
            (before) =>
              Effect.sync(() => {
                for (const [key, value] of Rec.toEntries(before))
                  if (value === undefined) delete Bun.env[key];
                  else Bun.env[key] = value;
              }),
          );
          resetExecutors();
          const env = readEnv({
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            HOME: world.home,
            COLLIE_CWD: world.project,
          });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const started = yield* client
            .start({
              project: world.project,
              id: "told",
              request: "start",
              input: { work: `the picker, logging in with ${GITLAB}` },
            })
            .pipe(Effect.orDie);
          expect(started.redacted).toEqual(["<gitlab token>"]);
          const view = yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (one) => one !== null && isSettled(one),
          );
          expect(view?.status.status).toBe("complete");
          const agent = (yield* Schema.decodeEffect(FakeState)(
            yield* fs.readFileString(`${Bun.env.FAKE_HERDR_LOG}.state.json`).pipe(Effect.orDie),
          ).pipe(Effect.orDie)).agents[0]!.name;

          const [delivered] = yield* carryOutAsked(
            env,
            [
              {
                kind: "deliver",
                run: started.runId,
                agent,
                text: `merge it with ${GITHUB}`,
                mode: "boundary",
              },
            ],
            { origin: "chat", requestId: "chat-1" },
          );
          expect(delivered).toMatchObject({ kind: "deliver", state: "applied" });
          expect(delivered?.note).toContain("removed 1 credential-shaped value(s): <github token>");

          const steered = yield* client
            .steer({ runId: started.runId, text: `and tag it, ${AWS}`, request: "steer" })
            .pipe(Effect.orDie);
          expect(steered.redacted).toEqual(["<aws key id>"]);

          const prompts = yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orDie);
          expect(
            yield* fs
              .readFileString(`${world.state}/agents/${started.runId}/build.prompt.md`)
              .pipe(Effect.orDie),
          ).toContain("the picker, logging in with <gitlab token>");
          expect(prompts).toContain("merge it with <github token>");
          for (const value of [GITLAB, GITHUB, AWS]) expect(prompts).not.toContain(value);
          expect(yield* holding(world.state, [GITLAB, GITHUB, AWS])).toEqual([]);
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);

test("text with nothing credential-shaped in it is written exactly as it was", () =>
  hosted("collie-credentials-plain-", ({ world }) =>
    Effect.gen(function* () {
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const started = yield* client
        .start({ project: world.project, id: "proof", request: "plain", input: { note: "a b" } })
        .pipe(Effect.orDie);
      expect(started.redacted).toBeUndefined();
      const view = yield* until(
        () => client.run({ runId: started.runId }).pipe(Effect.orDie),
        (one) => (one?.waiting.length ?? 0) > 0,
      );
      expect(view?.input).toEqual({ note: "a b" });
    }),
  ));

test("what was removed is said by kind, with where to give a credential instead", () => {
  expect(removedNotice([])).toBeNull();
  const said = removedNotice(["<gitlab token>", "<gitlab token>", "<jwt>"])!;
  expect(said).toStartWith("removed 3 credential-shaped value(s): <gitlab token>, <jwt>.");
  expect(said).toContain("docs/using.md#credentials-never-go-in-a-goal-or-a-steer");
});

test("the CLI says what it removed from an answer, and the answer still lands", () =>
  hosted("collie-credentials-cli-", ({ world }) =>
    Effect.gen(function* () {
      const run = yield* hostedRun(world, "wait for an answer");
      const answered = yield* collie(world, ["run", "answer", run.id, `use ${GITLAB}`]);
      expect(answered.envelope).toMatchObject({
        ok: true,
        data: { value: "use <gitlab token>", redacted: ["<gitlab token>"] },
      });
    }),
  ));
