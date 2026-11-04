import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { admitted, budgetOf, startOnHold } from "../../tools/budget";

const dir = process.argv[2]!;
const marker = process.argv[3];

BunRuntime.runMain(
  Effect.gen(function* () {
    const hold = yield* admitted(dir, budgetOf(24), "whole", 12, () => Effect.void);
    if (marker !== undefined) {
      yield* Console.log("held");
      yield* Effect.promise(() => Bun.stdin.stream().getReader().read());
    }
    const cmd =
      marker === undefined ? ["sleep", "60"] : ["sh", "-c", 'touch "$0"; exec sleep 60', marker];
    const child = yield* startOnHold(dir, hold.id, cmd, { env: process.env, kind: "whole" });
    yield* Console.log(child.pid);
    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
