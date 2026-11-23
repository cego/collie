// WARNING: no Bun-only import: the view bundles this module.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Cause, Predicate, Schema } from "effect";
import * as RpcClientError from "effect/rpc/RpcClientError";
import { ActionFailed } from "./flock";

const RENEWED = "the connection was renewed before this finished";

export const saidOf = (cause: Cause.Cause<Error | string>) => {
  const failed = Option.getOrUndefined(Arr.findFirst(cause.reasons, Cause.isFailReason));
  if (failed !== undefined) {
    const { error } = failed;
    if (Predicate.isString(error)) return error;
    return Schema.is(ActionFailed)(error)
      ? error.reason
      : Schema.is(RpcClientError.RpcClientError)(error)
        ? error.reason.message
        : error.message;
  }
  const died = Option.getOrUndefined(Arr.findFirst(cause.reasons, Cause.isDieReason));
  if (died === undefined) return RENEWED;
  return Predicate.isError(died.defect) ? died.defect.message : String(died.defect);
};
