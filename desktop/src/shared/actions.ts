import { Cause, Exit, Option, Result, type Schema } from "effect";
import * as Arr from "effect/Array";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type { ActionFailed, DesktopAction } from "./flock";
import { saidOf } from "./said";
import type { OfferView } from "../../../src/board-model";

export type Failed = ActionFailed | RpcClientError.RpcClientError;

export const failureOf = (cause: Cause.Cause<Failed>) => {
  const found = Cause.findError(cause);
  return Result.isSuccess(found) && found.success._tag === "ActionFailed"
    ? found.success
    : { reason: saidOf(cause), request: undefined, step: undefined, refused: undefined };
};

export const newRequest = () => SecureRandom.uuidV4Unsafe();

export interface ActionNotice {
  readonly title: string;
  readonly color: "success" | "error";
  readonly actions?: Array<{ label: string; onClick: () => Promise<boolean> }>;
}

export const actionRunner = (
  act: (input: {
    payload: {
      installation: string;
      action: DesktopAction;
      request: string | undefined;
      unsent?: string;
    };
  }) => Promise<Exit.Exit<string, Failed>>,
  tell: (notice: ActionNotice) => void,
) => {
  // WARNING: one gesture is one request, reused on every try; the host takes it once.
  const run = (
    installation: string,
    action: DesktopAction,
    again?: string,
    applied?: () => void,
    unsent?: () => string | undefined,
    tried?: (done: boolean | null, failed?: ReturnType<typeof failureOf>) => void,
  ) => {
    const request = again ?? newRequest();
    const why = unsent?.();
    tried?.(null);
    return act({
      payload:
        why === undefined
          ? { installation, action, request }
          : { installation, action, request, unsent: why },
    }).then((exit) => {
      if (Exit.isSuccess(exit)) {
        applied?.();
        tried?.(true);
        tell({ title: exit.value, color: "success" });
        return true;
      }
      const failed = failureOf(exit.cause);
      tried?.(false, failed);
      tell({
        title: failed.reason,
        color: "error",
        actions: [
          {
            label: "Try again",
            onClick: () => run(installation, action, request, applied, unsent, tried),
          },
        ],
      });
      return false;
    });
  };

  return run;
};

export const offerKey = (offer: Pick<OfferView, "id" | "run">) =>
  offer.run === undefined ? offer.id : `${offer.run}:${offer.id}`;

export const offeringOf = (runId: string, offer: Pick<OfferView, "id" | "run"> | null) => ({
  runId: offer?.run ?? runId,
  offer: offer?.id ?? null,
});

export const chosenOffer = (offers: ReadonlyArray<OfferView>, chosen: string | null) =>
  Option.getOrUndefined(Arr.findFirst(offers, (offer) => offerKey(offer) === chosen));

export const invokeOf = (
  runId: string,
  offer: OfferView,
  input: Readonly<Record<string, Schema.Json>>,
) => ({ _tag: "Invoke" as const, runId: offer.run ?? runId, offer: offer.id, input });
