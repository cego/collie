// A failure as the window says it: a sentence about the work, never about Effect.

import { expect, test } from "bun:test";
import { Cause } from "effect";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { ActionFailed } from "../src/shared/flock";
import { saidOf } from "../src/shared/said";

const withStack = new Error("the board could not be read");

test.each([
  ["an action that failed", Cause.fail(new ActionFailed({ reason: "no Run r-1" })), "no Run r-1"],
  [
    "a broken connection",
    Cause.fail(
      new RpcClientError({
        reason: new RpcClientDefect({ message: "socket closed", cause: null }),
      }),
    ),
    "socket closed",
  ],
  ["an interrupt", Cause.interrupt(82), "the connection was renewed before this finished"],
  ["a defect", Cause.die(withStack), "the board could not be read"],
  ["a defect that is not an error", Cause.die("gone"), "gone"],
  [
    "a failure beside an interrupt",
    Cause.combine(Cause.interrupt(82), Cause.fail(new ActionFailed({ reason: "refused" }))),
    "refused",
  ],
])("%s is said in a sentence", (_, cause, said) => {
  const text = saidOf(cause);
  expect(text).toBe(said);
  for (const effect of ["fiber", "[cause]", "InterruptError", "    at "])
    expect(text).not.toContain(effect);
});
