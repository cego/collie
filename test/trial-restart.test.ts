import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Effect, FileSystem, Stream } from "effect";
import type { BoardMessage } from "../src/board-model";
import { hostLockOf } from "../src/lock";
import { restartConfirmed, sentOnRunCard } from "../tools/trial-restart";
import { FakeBin } from "./support/bin";
import { runEffect } from "./support/effect";
import { task } from "./support/task";

const delivery = {
  id: "run-c-08-step-1",
  at: "2026-11-24T08:35:18.515Z",
  state: "acknowledged",
  cause: { kind: "step", ref: "08-bounded-check-output.md" },
};

test("the sequence recorded with a delivery is the change of the Run's own card, never another task's", () => {
  const board: ReadonlyArray<BoardMessage> = [
    { _tag: "Upsert", seq: 5, task: task({ id: "other", run: "run-other", runs: ["run-other"] }) },
    { _tag: "Upsert", seq: 7, task: task({ id: "mine", run: "run-c", runs: ["run-c"] }) },
  ];
  return runEffect(
    Effect.map(
      sentOnRunCard(Stream.fromIterable(board), "run-c", Effect.succeedSome(delivery)),
      (found) => expect(found).toEqual(Option.some({ seq: 7, delivery })),
    ),
  );
});

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
