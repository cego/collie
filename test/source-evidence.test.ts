import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { connect } from "../src/host";
import { readVerifications } from "../src/verify";
import { evidenceDir } from "../src/engine";
import { exec } from "./support/command";
import { until } from "./support/host";
import { collie, proves } from "./support/world";

const Ran = Schema.Struct({ verification: Schema.Struct({ id: Schema.String }) });
const Started = Schema.Struct({ run: Schema.String });

test(
  "a recovery-empty follow-up collects the source's pre-fix records on the card it consumed, and none for other work, a post-fix replay or rewritten history",
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
          const red = yield* verify("regression", ["--expect", "fail", "--", ...regression]);
          yield* commit("fix.txt", "the fix");
          yield* fs.writeFileString(fixed, "").pipe(Effect.orDie);
          const green = yield* verify("regression", ["--", ...regression]);
          yield* fs.remove(fixed).pipe(Effect.orDie);
          const replayed = yield* verify("regression", ["--expect", "fail", "--", ...regression]);
          yield* commit("notes.md", "the notes");
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
          const followUp = (request: string, input: ReadonlyArray<string> = []) =>
            Effect.gen(function* () {
              const started = yield* collie(world, [
                "run",
                "action",
                source,
                "again",
                ...input,
                "--request-id",
                request,
              ]);
              expect(started.envelope.error).toBeUndefined();
              const { run: runId } = yield* Schema.decodeUnknownEffect(Started)(
                started.envelope.data,
              ).pipe(Effect.orDie);
              const done = yield* until(
                () => client.run({ runId }).pipe(Effect.orDie),
                (view) => view?.status.status === "complete",
              );
              return done?.status.status === "complete" ? done.status.value : null;
            });

          expect(yield* followUp("other", ["--input", "text=other work"])).toEqual([]);
          expect(yield* followUp("carry")).toEqual([red, green]);
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
