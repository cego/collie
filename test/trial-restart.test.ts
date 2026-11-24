import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Effect, FileSystem, Stream } from "effect";
import type { BoardMessage } from "../src/board-model";
import { hostLockOf } from "../src/lock";
import { Deliveries } from "../src/steering";
import type { Delivery } from "../src/steering";
import { ledgerDelivery, restartConfirmed, sentOnRunCard } from "../tools/trial-restart";
import { recordsAt } from "./support/records";
import { FakeBin } from "./support/bin";
import { runEffect } from "./support/effect";
import { task } from "./support/task";

const line = (run: string, ref: string, state: Delivery["state"], at: string) => ({
  id: `${run}-${ref}-step-1`,
  at,
  run,
  incarnation: "t1",
  agent: `${run}-build-r1`,
  causal_key: `${run}-${ref}`,
  request_id: `${run}-${ref}-step`,
  cause: { kind: "step" as const, ref },
  mode: "boundary" as const,
  text_hash: "h",
  intent_version: 1,
  attempt: 1,
  state,
});

test("the sequence recorded with a restart is ticket 8's delivery event in the ledger, never a board change", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "trial-restart-ledger-" });
        const ticket8 = "08-bounded-check-output.md";
        const found = yield* Effect.gen(function* () {
          const deliveries = yield* Deliveries;
          for (const one of [
            line("run-other", ticket8, "submitted", "2026-11-24T08:35:10.000Z"),
            line("run-c", "07-list-parked.md", "acknowledged", "2026-11-24T08:35:11.000Z"),
            line("run-c", ticket8, "reserved", "2026-11-24T08:35:17.597Z"),
            line("run-c", ticket8, "submitted", "2026-11-24T08:35:18.515Z"),
            line("run-c", ticket8, "acknowledged", "2026-11-24T08:35:18.515Z"),
          ]) {
            yield* deliveries.append(one);
          }
          const board: ReadonlyArray<BoardMessage> = [
            {
              _tag: "Upsert",
              seq: 5,
              task: task({ id: "other", run: "run-other", runs: ["run-other"] }),
            },
            { _tag: "Upsert", seq: 70, task: task({ id: "mine", run: "run-c", runs: ["run-c"] }) },
          ];
          return yield* sentOnRunCard(
            Stream.fromIterable(board),
            "run-c",
            ledgerDelivery("run-c", ticket8),
          );
        }).pipe(Effect.provide(recordsAt(dir)));
        expect(Option.map(found, (one) => [one.seq, one.delivery.state])).toEqual(
          Option.some([4, "submitted"]),
        );
      }),
    ),
  ));

const restarting = (collie: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "trial-restart-" });
      const bin = yield* FakeBin.make(`${dir}/bin`);
      yield* bin.add("collie", collie);
      yield* fs.writeFileString(hostLockOf(dir), `{"pid":100,"start":"1"}`);
      return yield* restartConfirmed(dir, "300 millis").pipe(
        Effect.ensuring(bin.restore()),
        Effect.result,
      );
    }),
  );

test("a restart counts once the trial's own host lock has a new owner", () =>
  runEffect(
    Effect.map(
      restarting(
        `printf '{"pid":200,"start":"2"}' > "$COLLIE_STATE_DIR/host.lock"; echo '{"ok":true}'`,
      ),
      (restarted) => expect(restarted._tag).toBe("Success"),
    ),
  ));

test("a refused restart, or one whose host never changed, fails instead of reading as done", () =>
  runEffect(
    Effect.map(
      Effect.all([
        restarting(`printf '{"pid":200,"start":"2"}' > "$COLLIE_STATE_DIR/host.lock"; exit 1`),
        restarting(`echo '{"ok":true}'`),
      ]),
      ([refused, unchanged]) =>
        expect([refused._tag, unchanged._tag]).toEqual(["Failure", "Failure"]),
    ),
  ));
