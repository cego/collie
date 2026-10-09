// A failure as the window says it: a sentence about the work, never a fiber or a stack.
// No Bun-only import: the view bundles this.

import { Cause, Predicate, Schema } from "effect";
import * as RpcClientError from "effect/rpc/RpcClientError";
import { ActionFailed } from "./flock";

const RENEWED = "the connection was renewed before this finished";

/** An `ActionFailed`'s reason, another error's message, or that its connection was renewed. */
export const saidOf = (cause: Cause.Cause<Error | string>): string => {
  const failed = cause.reasons.find(Cause.isFailReason);
  if (failed !== undefined) {
    const { error } = failed;
    if (Predicate.isString(error)) return error;
    return Schema.is(ActionFailed)(error)
      ? error.reason
      : Schema.is(RpcClientError.RpcClientError)(error)
        ? error.reason.message
        : error.message;
  }
  const died = cause.reasons.find(Cause.isDieReason);
  if (died === undefined) return RENEWED;
  return Predicate.isError(died.defect) ? died.defect.message : String(died.defect);
};
