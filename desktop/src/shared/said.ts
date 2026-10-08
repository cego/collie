// A failure as the window says it: a sentence about the work, never a fiber or a stack.

import { Cause, Predicate, Schema } from "effect";
import * as RpcClientError from "effect/rpc/RpcClientError";
import { ActionFailed } from "./flock";

const RENEWED = "the connection was renewed before this finished";

/** An `ActionFailed`'s reason, another error's message, or that its connection was renewed. */
export const saidOf = (cause: Cause.Cause<Error>): string => {
  const failed = cause.reasons.find(Cause.isFailReason);
  if (failed !== undefined)
    return Schema.is(ActionFailed)(failed.error)
      ? failed.error.reason
      : Schema.is(RpcClientError.RpcClientError)(failed.error)
        ? failed.error.reason.message
        : failed.error.message;
  const died = cause.reasons.find(Cause.isDieReason);
  if (died === undefined) return RENEWED;
  return Predicate.isError(died.defect) ? died.defect.message : String(died.defect);
};
