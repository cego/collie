// A front door's wait while the fixture's live Runs keep the host building its board.

// oxlint-disable-next-line effecttsgo/node-builtin-import -- Shares record-open's isolated host world.
import { homedir } from "node:os";
import { Clock, Console, Effect, FileSystem, Schedule, Schema, Stream } from "effect";
import * as Str from "effect/String";
import { connect, frontDoor, socketOf } from "../src/host";
import { runEffect } from "../test/support/effect";
import { stopHost } from "../test/support/host";
import { prepare } from "./record-open/fixture";
import { filledSinceStart, measuring, refusal, userStateDir } from "./record-open/guards";
import { summaryOf } from "./record-open/stats";
import { enterWorld, live, recordMarksFile, userEnv, world } from "./record-open/world";

await runEffect(
  measuring(
    `${userStateDir(homedir(), userEnv)}/measurements/machine.lock`,
    Console.error,
    Effect.gen(function* () {
      const refused = yield* refusal(
        { state: world.state, socket: socketOf(world.state) },
        { home: homedir(), env: userEnv },
      );
      if (refused !== null) return yield* Effect.die(new Error(refused));
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(live, { recursive: true, force: true });
      yield* enterWorld;
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- Only the isolated host inherits this setting.
      delete Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      yield* Effect.addFinalizer(() =>
        stopHost(world.state).pipe(
          Effect.ensuring(fs.remove(live, { recursive: true, force: true }).pipe(Effect.orDie)),
        ),
      );
      yield* Console.error("preparing 80 fixture Runs");
      const fixture = yield* prepare({ runs: 80, large: 0, old: 5, live: 3 });
      yield* Effect.scoped(connect(world.state));
      const door = yield* frontDoor(socketOf(world.state));
      yield* fs.readFileString(`${world.state}/host.log`).pipe(
        Effect.map(filledSinceStart),
        Effect.orElseSucceed(() => false),
        Effect.repeat({ until: (filled) => filled, schedule: Schedule.spaced("100 millis") }),
      );
      yield* fs.writeFileString(recordMarksFile, "");
      yield* Console.error("sampling 20 verify and read answers");
      const verify: number[] = [];
      const read: number[] = [];
      for (let at = 0; at < 20; at++) {
        const began = yield* Clock.currentTimeNanos;
        let first = true;
        let result = false;
        yield* door
          .verify({
            runId: fixture.live[at % fixture.live.length]!,
            name: `front-door-${at}`,
            executable: "/usr/bin/true",
            argv: [],
            cwd: world.project,
            expect: "pass",
            again: true,
          })
          .pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (first) {
                  verify.push(Number((yield* Clock.currentTimeNanos) - began) / 1_000_000);
                  first = false;
                }
                if (event._tag === "Result") result = event.verification.result === "pass";
              }),
            ),
          );
        if (first || !result) return yield* Effect.die(new Error("verify did not pass"));
        const started = yield* Clock.currentTimeNanos;
        const answer = yield* door.read({
          tool: "collie_run",
          input: { run: fixture.settled[at]! },
        });
        if (!Str.includes(fixture.settled[at]!)(answer))
          return yield* Effect.die(new Error("collie_run did not answer for the requested Run"));
        read.push(Number((yield* Clock.currentTimeNanos) - started) / 1_000_000);
      }
      yield* stopHost(world.state);
      const builds = Array.from(
        Str.matchAll(/^\d+ board:built (\d+)$/gm)(yield* fs.readFileString(recordMarksFile)),
        (match) => Number(match[1]),
      );
      if (builds.length === 0) return yield* Effect.die(new Error("no board builds collected"));
      yield* Console.log(
        yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite)),
        )({
          verify_first_p95_ms: summaryOf(verify, 0).p95,
          read_p95_ms: summaryOf(read, 0).p95,
          board_build_p50_ms: summaryOf(builds, 0).p50,
        }),
      );
    }).pipe(Effect.scoped, Effect.orDie),
  ),
);
