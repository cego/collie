// The board's actions, each asked of the Machine its card is on. What came of one is
// said in a toast, in the host's own words when it said no.

import { useAtomSet } from "@effect/atom-vue";
import { Cause, Exit, Result } from "effect";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { ActionFailed, DesktopAction } from "../../../src/shared/flock";
import { FlockClient } from "../flock";

const actAtom = FlockClient.mutation("act");
const offersAtom = FlockClient.mutation("offers");
const workflowsAtom = FlockClient.mutation("workflows");

type Failed = ActionFailed | RpcClientError.RpcClientError;

const why = (cause: Cause.Cause<Failed>) => {
  const found = Cause.findError(cause);
  if (Result.isFailure(found)) return Cause.pretty(cause);
  return found.success._tag === "ActionFailed" ? found.success.reason : found.success.message;
};

export const useActions = () => {
  const toast = useToast();
  const act = useAtomSet(() => actAtom, { mode: "promiseExit" });
  const offers = useAtomSet(() => offersAtom, { mode: "promiseExit" });
  const workflows = useAtomSet(() => workflowsAtom, { mode: "promiseExit" });

  /** A failed read is said once, here; its caller gets nothing back. */
  const read = <A>(exit: Exit.Exit<A, Failed>) => {
    if (Exit.isSuccess(exit)) return exit.value;
    toast.add({ title: why(exit.cause), color: "error" });
    return null;
  };

  return {
    run: (installation: string, action: DesktopAction) =>
      act({ payload: { installation, action } }).then((exit) => {
        toast.add(
          Exit.isSuccess(exit)
            ? { title: exit.value, color: "success" }
            : { title: why(exit.cause), color: "error" },
        );
        return Exit.isSuccess(exit);
      }),
    offersOf: (installation: string, runId: string) =>
      offers({ payload: { installation, runId } }).then(read),
    workflowsIn: (installation: string, project: string) =>
      workflows({ payload: { installation, project } }).then(read),
  };
};
