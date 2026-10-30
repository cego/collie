// `collie verify` waits in the host while its Machine is short of memory, for a human as for
// an agent, says so first, and its result is the command's
// (ADR-draft-new-work-waits-while-its-machine-is-short-of-memory, D2, D4, D5 and D7).

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Schema, flow, Result } from "effect";
import { connect } from "../src/host";
import { resetExecutors } from "../src/executors";
import { runDir } from "../src/engine";
import { Launched } from "../src/launches";
import { holdsBudgetOf, memoryWaitOf, waitLine } from "../src/memory-wait";
import { everyRegistered } from "../src/registry";
import { readVerifications } from "../src/verify";
import { deliveriesOf } from "../src/steering";
import { evidenceDir } from "../src/engine";
import { exec } from "./support/command";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const Shown = Schema.Struct({ memory: Schema.NullOr(Schema.String) });
const decodeLaunched = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Launched)),
  Result.getOrThrow,
);
const Ran = Schema.Struct({
  ran: Schema.Boolean,
  verification: Schema.Struct({ exit: Schema.Finite }),
});

test(
  "a verify waits while the Machine is short, pausing only its own agent's budget; nothing a human frees memory with waits, and nothing running is stopped",
  () =>
    proves(
      "collie-verify-memory-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          const proc = `${world.home}/proc`;
          const memory = (availableGiB: number) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(proc, { recursive: true });
              yield* fs.writeFileString(
                `${proc}/meminfo`,
                `MemTotal: ${100 * 1048576} kB\nMemAvailable: ${availableGiB * 1048576} kB\n`,
              );
            }).pipe(Effect.orDie);
          yield* memory(50);
          yield* fs.writeFileString(outputs, encode([null])).pipe(Effect.orDie);
          yield* fs.writeFileString(`${world.project}/thing.txt`, "one\n").pipe(Effect.orDie);
          yield* exec(["git", "add", "-A"], { cwd: world.project });
          yield* exec(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "one"],
            { cwd: world.project },
          );
          const set = {
            FAKE_HERDR_OUTPUTS: outputs,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            COLLIE_PROC: proc,
            COLLIE_MEMORY_EVERY: "100 millis",
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
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "attended",
              request: "start",
              input: { work: "it" },
            })
            .pipe(Effect.orDie);
          const launched = decodeLaunched(
            yield* until(
              () =>
                fs
                  .readFileString(`${world.state}/agents/${runId}/build.launch.json`)
                  .pipe(Effect.orElseSucceed(() => "")),
              (one) => one !== "",
            ),
          );
          const pane = Option.getOrUndefined(
            Arr.findFirst(yield* everyRegistered(world.state), (entry) => entry.runId === runId),
          )!.paneId;
          const verify = (name: string, paneId: string) =>
            collie(
              world,
              ["verify", "--run", runId, "--cwd", world.project, "--name", name, "--", "/bin/true"],
              { HERDR_PANE_ID: paneId },
            );
          const waiting = () => memoryWaitOf(runDir(world.state, runId));
          const ran = () =>
            readVerifications(evidenceDir(world.state, runId)).pipe(
              Effect.orElseSucceed(() => []),
              Effect.map((all) => all.length),
            );

          yield* memory(2);
          for (const [name, paneId, pauses] of [
            ["as-agent", pane, true],
            ["as-human", "not-an-agent", false],
          ] as const) {
            const asked = yield* Effect.forkChild(verify(name, paneId));
            const wait = yield* until(waiting, (one) => one !== null);
            expect(wait?.sentence).toMatch(
              /^waiting for memory on .+: 2\.0 of 100\.0 GB available$/,
            );
            expect(yield* holdsBudgetOf(world.state, runId, launched.agent)).toBe(pauses);
            const shown = yield* collie(world, ["run", "show", runId]);
            expect(
              (yield* Schema.decodeUnknownEffect(Shown)(shown.envelope.data).pipe(Effect.orDie))
                .memory,
            ).toBe(waitLine(wait!));
            const before = yield* ran();
            yield* memory(50);
            const done = yield* Fiber.join(asked);
            expect(done.exit).toBe(0);
            expect(done.stderr).toContain("waiting for memory on ");
            expect(
              yield* Schema.decodeUnknownEffect(Ran)(done.envelope.data).pipe(Effect.orDie),
            ).toEqual({
              ran: true,
              verification: expect.objectContaining({ exit: 0 }),
            });
            expect(yield* ran()).toBe(before + 1);
            expect(
              Arr.filter(yield* deliveriesOf(world.state, runId), (one) =>
                pipe_(one.delivery.cause.ref, Str.startsWith("verify-")),
              ),
            ).toHaveLength(1);
            expect(yield* waiting()).toBeNull();
            yield* memory(2);
          }

          // The agent that was running when the Machine became short is still there.
          expect(Arr.some(yield* everyRegistered(world.state), (one) => one.runId === runId)).toBe(
            true,
          );

          // What a human frees memory with never waits; a new Run's first agent does.
          const second = yield* client
            .start({
              project: world.project,
              id: "attended",
              request: "start-2",
              input: { work: "more" },
            })
            .pipe(Effect.orDie);
          expect(yield* client.run({ runId: second.runId }).pipe(Effect.orDie)).not.toBeNull();
          yield* until(
            () => memoryWaitOf(runDir(world.state, second.runId)),
            (one) => one !== null,
          );
          yield* client
            .steer({ runId, text: "Carry on.", request: "steer-short" })
            .pipe(Effect.orDie);
          for (const set of [true, false])
            yield* client
              .control({ runId, control: "hold", set, request: `hold-${set}` })
              .pipe(Effect.orDie);
          yield* client.sweep({ request: "sweep-short" }).pipe(Effect.orDie);
          yield* client
            .control({ runId: second.runId, control: "stop", set: true, request: "stop-short" })
            .pipe(Effect.orDie);
          yield* until(
            () => memoryWaitOf(runDir(world.state, second.runId)),
            (one) => one === null,
          );
          yield* memory(50);
          yield* Effect.sleep("3 seconds");
          const agentsDir = `${world.state}/agents/${second.runId}`;
          expect(yield* fs.exists(`${agentsDir}/build.launch.json`)).toBe(false);
          expect(yield* fs.readFileString(`${agentsDir}/agents.log`)).toContain(
            "stopped after waiting",
          );
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["attended.workflow.ts"],
    ),
  120_000,
);
