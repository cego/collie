// The board's actions, each asked of the Machine its card is on. What came of one is
// said in a toast, in the host's own words when it said no.

import { AtomRegistry, injectRegistry, useAtomSet } from "@effect/atom-vue";
import { Cause, Effect, Exit, Result } from "effect";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { ActionFailed, DesktopAction } from "../../../src/shared/flock";
import { FlockClient } from "../flock";

const actAtom = FlockClient.mutation("act");
const offersAtom = FlockClient.mutation("offers");
const workflowsAtom = FlockClient.mutation("workflows");
const openLinkAtom = FlockClient.mutation("openLink");

type Failed = ActionFailed | RpcClientError.RpcClientError;

const failureOf = (cause: Cause.Cause<Failed>) => {
  const found = Cause.findError(cause);
  if (Result.isFailure(found)) return { reason: Cause.pretty(cause), request: undefined };
  return found.success._tag === "ActionFailed"
    ? found.success
    : { reason: found.success.message, request: undefined };
};

export const useActions = () => {
  const toast = useToast();
  const act = useAtomSet(() => actAtom, { mode: "promiseExit" });
  const offers = useAtomSet(() => offersAtom, { mode: "promiseExit" });
  const workflows = useAtomSet(() => workflowsAtom, { mode: "promiseExit" });
  const openLink = useAtomSet(() => openLinkAtom, { mode: "promiseExit" });
  const registry = injectRegistry();
  /** One part of a Run's item: its own call, since several are read at once. */
  const runFile = (payload: { installation: string; runId: string; ref: string; offset: number }) =>
    Effect.runPromiseExit(
      AtomRegistry.getResult(registry, FlockClient.runtime).pipe(
        Effect.flatMap((context) =>
          FlockClient.use((client) => client("runFile", payload)).pipe(
            Effect.provideContext(context),
          ),
        ),
      ),
    );

  /** A failed read is said once, here; its caller gets nothing back. */
  const read = <A>(exit: Exit.Exit<A, Failed>) => {
    if (Exit.isSuccess(exit)) return exit.value;
    toast.add({ title: failureOf(exit.cause).reason, color: "error" });
    return null;
  };

  /**
   * A failure offers to try again under the same request id, so a request the host did
   * take before the reply was lost is not done twice.
   */
  const run = (installation: string, action: DesktopAction, again?: string): Promise<boolean> =>
    act({
      payload: { installation, action, request: again },
    }).then((exit) => {
      if (Exit.isSuccess(exit)) {
        toast.add({ title: exit.value, color: "success" });
        return true;
      }
      const { reason, request } = failureOf(exit.cause);
      toast.add({
        title: reason,
        color: "error",
        actions:
          request === undefined
            ? []
            : [{ label: "Try again", onClick: () => void run(installation, action, request) }],
      });
      return false;
    });

  return {
    run,
    openLink: (url: string) => openLink({ payload: { url } }),
    offersOf: (installation: string, runId: string) =>
      offers({ payload: { installation, runId } }).then(read),
    workflowsIn: (installation: string, project: string) =>
      workflows({ payload: { installation, project } }).then(read),
    /** A Run's item by reference, as text, read part by part until all of it is here. */
    textOf: async (installation: string, runId: string, ref: string) => {
      // Streamed, so a character split across two parts is decoded whole.
      const decoder = new TextDecoder();
      let text = "";
      let offset = 0;
      for (;;) {
        const part = read(await runFile({ installation, runId, ref, offset }));
        if (part === null) return null;
        if (part.encoding === "utf8" && offset === 0) return part.content;
        const bytes = Uint8Array.from(atob(part.content), (c) => c.charCodeAt(0));
        text += decoder.decode(bytes, { stream: true });
        offset += bytes.length;
        if (offset >= part.size || bytes.length === 0) return text + decoder.decode();
      }
    },
  };
};
