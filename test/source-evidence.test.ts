import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { connect } from "../src/host";
import { readVerifications } from "../src/verify";
import { evidenceDir, runDir } from "../src/engine";
import { exec } from "./support/command";
import { until } from "./support/host";
import { collie, proves } from "./support/world";

const Ran = Schema.Struct({ verification: Schema.Struct({ id: Schema.String }) });
const Started = Schema.Struct({ run: Schema.String });

test(
  "a recovery-empty follow-up collects the source's pre-fix records on the card it consumed, through later continuations and recoveries, and none for other work, a post-fix replay or rewritten history",
  () =>
    proves(
      "collie-source-evidence-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const git = (...args: ReadonlyArray<string>) =>
            exec(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
              cwd: world.project,
            }).pipe(Effect.map((ran) => Str.trim(ran.stdout)));
          const commit = (file: string, message: string) =>
            Effect.gen(function* () {
              yield* fs
                .writeFileString(`${world.project}/${file}`, `${message}\n`)
                .pipe(Effect.orDie);
              yield* git("add", "-A");
              yield* git("commit", "-qm", message);
              return yield* git("rev-parse", "HEAD");
            });
          const before = yield* commit("test.txt", "the test");
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId: source } = yield* client
            .start({
              project: world.project,
              id: "carried",
              request: "source",
              input: { text: "the work", wait: "yes" },
            })
            .pipe(Effect.orDie);
          yield* until(
            () => client.run({ runId: source }).pipe(Effect.orDie),
            (view) => (view?.waiting.length ?? 0) > 0,
          );
          const verify = (name: string, rest: ReadonlyArray<string>) =>
            Effect.gen(function* () {
              const ran = yield* collie(world, [
                "verify",
                "--run",
                source,
                "--cwd",
                world.project,
                "--name",
                name,
                ...rest,
              ]);
              expect(ran.envelope.error).toBeUndefined();
              return (yield* Schema.decodeUnknownEffect(Ran)(ran.envelope.data).pipe(Effect.orDie))
                .verification.id;
            });
          const fixed = `${world.home}/fixed`;
          const regression = ["/usr/bin/test", "-e", fixed] as const;
          yield* fs.writeFileString(fixed, "").pipe(Effect.orDie);
          const baseline = yield* verify("regression", ["--", ...regression]);
          yield* fs.remove(fixed).pipe(Effect.orDie);
          yield* fs
            .writeFileString(`${world.project}/test.txt`, "the assertion\n")
            .pipe(Effect.orDie);
          yield* git("add", "test.txt");
          yield* git("commit", "-qm", "the regression assertion");
          const red = yield* verify("regression", ["--expect", "fail", "--", ...regression]);
          yield* commit("fix.txt", "the fix");
          yield* fs.writeFileString(fixed, "").pipe(Effect.orDie);
          const green = yield* verify("regression", ["--", ...regression]);
          yield* commit("notes.md", "notes after the fix");
          yield* fs.remove(fixed).pipe(Effect.orDie);
          const replayed = yield* verify("regression", ["--expect", "fail", "--", ...regression]);
          yield* commit("notes.md", "the notes");
          yield* fs.writeFileString(fixed, "").pipe(Effect.orDie);
          const rechecked = yield* verify("regression", ["--", ...regression]);
          yield* client
            .answer({ runId: source, decision: "done", value: "yes", request: "done" })
            .pipe(Effect.orDie);
          yield* until(
            () => client.run({ runId: source }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          const late = yield* verify("late", ["--", "/bin/true"]);
          const sourced = yield* readVerifications(evidenceDir(world.state, source)).pipe(
            Effect.orDie,
          );
          const settled = (runId: string) =>
            Effect.map(
              until(
                () => client.run({ runId }).pipe(Effect.orDie),
                (view) => view?.status.status === "complete",
              ),
              (done) => (done?.status.status === "complete" ? done.status.value : null),
            );
          const offered = (from: string, request: string, input: ReadonlyArray<string>) =>
            Effect.gen(function* () {
              const started = yield* collie(world, [
                "run",
                "action",
                from,
                "again",
                ...input,
                "--request-id",
                request,
              ]);
              expect(started.envelope.error).toBeUndefined();
              return (yield* Schema.decodeUnknownEffect(Started)(started.envelope.data).pipe(
                Effect.orDie,
              )).run;
            });
          const followUp = (request: string, input: ReadonlyArray<string> = [], from = source) =>
            Effect.flatMap(offered(from, request, input), settled);
          const proof = [baseline, red, green, rechecked];

          expect(yield* followUp("other", ["--input", "text=other work"])).toEqual([]);
          const carried = yield* offered(source, "carry", []);
          expect(yield* settled(carried)).toEqual(proof);
          expect(yield* followUp("chained", [], carried)).toEqual(proof);
          const recovered = yield* offered(carried, "recovered", [
            "--input",
            "text=recovered work",
            "--input",
            "wait=yes",
          ]);
          yield* until(
            () => client.run({ runId: recovered }).pipe(Effect.orDie),
            (view) => (view?.waiting.length ?? 0) > 0,
          );
          yield* fs
            .writeFileString(`${runDir(world.state, recovered)}/recovery-parent`, carried)
            .pipe(Effect.orDie);
          yield* client
            .answer({ runId: recovered, decision: "done", value: "yes", request: "recovered-done" })
            .pipe(Effect.orDie);
          expect(yield* settled(recovered)).toEqual(proof);
          expect(Arr.map(sourced, (one) => one.id)).toEqual(
            expect.arrayContaining([replayed, late]),
          );

          yield* git("reset", "-q", "--hard", before);
          yield* commit("other.txt", "rewritten");
          expect(yield* followUp("rewritten")).toEqual([]);
        }),
      ["carried.workflow.ts"],
    ),
  120_000,
);
