import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { connect } from "../src/host";
import { runEffect } from "./support/effect";
import { until } from "./support/host";
import { twoMachines } from "./support/peers";

test(
  "a peer connection resets a parked Run's backoff",
  () =>
    runEffect(
      twoMachines(
        "recovery-link-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${first.world.project}/dirty`, "waiting").pipe(Effect.orDie);
            const started = yield* first.cli(
              [
                "run",
                "start",
                "rechecks",
                "--input",
                "cause=checkout-dirty-collie",
                "--input",
                "mr=",
                "--input",
                `file=${first.world.home}/fact`,
              ],
              { COLLIE_RECOVERY_EVERY: "100 millis" },
            );
            expect(started.envelope).toMatchObject({ ok: true });
            const { runId } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ runId: Schema.String }),
            )(started.envelope.data).pipe(Effect.orDie);
            const client = yield* connect(first.world.state).pipe(Effect.orDie);
            yield* until(
              () => client.runMetrics({ runId }).pipe(Effect.orDie),
              (lines) =>
                Arr.some(lines, (line) => line.action === "rechecked" && line.value >= 800),
            );
            const other = yield* second.cli([
              "run",
              "start",
              "rechecks",
              "--input",
              "cause=unknown",
              "--input",
              "mr=",
              "--input",
              `file=${second.world.home}/fact`,
            ]);
            const remote = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ runId: Schema.String }),
            )(other.envelope.data).pipe(Effect.orDie);
            yield* first.lists([second]);
            expect((yield* first.cli(["run", "show", remote.runId])).envelope).toMatchObject({
              ok: true,
            });
            yield* until(
              () => client.peers().pipe(Effect.orDie),
              (peers) => Arr.some(peers, (peer) => peer.state === "live"),
            );
            const lines = yield* until(
              () => client.runMetrics({ runId }).pipe(Effect.orDie),
              (lines) =>
                Arr.filter(lines, (line) => line.action === "rechecked" && line.value === 100)
                  .length >= 2,
            );
            expect(Arr.filter(lines, (line) => line.action === "resumed")).toEqual([]);
          }),
        ["rechecks.workflow.ts"],
      ),
    ),
  120_000,
);
