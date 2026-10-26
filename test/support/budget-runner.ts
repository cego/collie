// A runner as `tools/test.ts` is one: it holds a whole suite's workers from the store named in
// its argument, starts a child on the hold, prints the child's pid and waits.
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { admitted, budgetOf, startOnHold } from "../../tools/budget";

const dir = process.argv[2]!;

BunRuntime.runMain(
  Effect.gen(function* () {
    const hold = yield* admitted(dir, budgetOf(24), "whole", 12, () => Effect.void);
    const child = yield* startOnHold(dir, hold.id, ["sleep", "60"], { env: process.env });
    yield* Console.log(child.pid);
    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
