// A `bun test` that `bun run test` did not start on a hold joins the Machine's budget as a
// small run (ADR-draft-test-processes-share-one-budget-per-machine, D4). Bun 1.4.4 runs this
// in every process that runs test files, and again for each file under `--isolate`, as
// `--parallel`'s workers are, so each run of it takes one worker and gives it back once its
// files end. Its wait is no test's: a test's timeout starts after it.

import { afterAll } from "bun:test";
import { availableParallelism } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Exit, Option, Scope } from "effect";
import { admitted, budgetOf, entriesOf, HOLD_ENV, shareOf, STORE } from "../../tools/budget";

const scope = Scope.makeUnsafe();

await Effect.runPromise(
  Effect.gen(function* () {
    if (Option.isSome(yield* Config.option(Config.String(HOLD_ENV)))) return;
    const override = yield* Config.option(Config.String("COLLIE_TEST_BUDGET"));
    const budget = budgetOf(availableParallelism(), Option.getOrUndefined(override));
    const share = shareOf(budget, "small");
    yield* admitted(STORE, budget, "small", 1, Console.error);
    const holding = (yield* entriesOf(STORE))
      .filter((one) => one.state === "held" && (share === budget.total || one.kind === "small"))
      .reduce((sum, one) => sum + one.workers, 0);
    yield* Console.error(`test: admitted; small runs hold ${holding} of their ${share} workers`);
  }).pipe(Scope.provide(scope), Effect.provide(BunServices.layer)),
);

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));
