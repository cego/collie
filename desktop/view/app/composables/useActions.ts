// The board's actions, each asked of the Machine its card is on. What came of one is
// said in a toast, in the host's own words when it said no.

import { AtomRegistry, injectRegistry, useAtomSet } from "@effect/atom-vue";
import { Cause, Effect, Encoding, Exit, Result, type Semaphore } from "effect";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { ActionFailed, DesktopAction } from "../../../src/shared/flock";
import { FlockClient } from "../flock";

const actAtom = FlockClient.mutation("act");
const offersAtom = FlockClient.mutation("offers");
const workflowsAtom = FlockClient.mutation("workflows");
const openLinkAtom = FlockClient.mutation("openLink");

type Failed = ActionFailed | RpcClientError.RpcClientError;

/** How one read of a Run's item is done. */
export interface ReadOptions {
  /** Bounds how many reads run at once. */
  readonly within?: Semaphore.Semaphore;
  /** Drops the read, said or not, once it is no longer wanted. */
  readonly signal?: AbortSignal;
  /** A failure is the caller's to show, not a toast. */
  readonly quiet?: boolean;
}

const joined = (parts: ReadonlyArray<Uint8Array>) => {
  const whole = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
};

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
    AtomRegistry.getResult(registry, FlockClient.runtime).pipe(
      Effect.flatMap((context) =>
        FlockClient.use((client) => client("runFile", payload)).pipe(
          Effect.provideContext(context),
        ),
      ),
    );

  /** An item whole: as text where it came in one part, else as its parts' bytes. */
  const partsOf = (installation: string, runId: string, ref: string) =>
    Effect.gen(function* () {
      const parts: Uint8Array[] = [];
      let offset = 0;
      for (;;) {
        const part = yield* runFile({ installation, runId, ref, offset });
        if (part.encoding === "utf8" && offset === 0)
          return { _tag: "Text", text: part.content } as const;
        const bytes = yield* Effect.fromResult(Encoding.decodeBase64(part.content)).pipe(
          Effect.orDie,
        );
        parts.push(bytes);
        offset += bytes.length;
        if (offset >= part.size || bytes.length === 0) return { _tag: "Bytes", parts } as const;
      }
    });

  /** A failed read is said once, here; its caller gets nothing back. */
  const read = <A>(exit: Exit.Exit<A, Failed>, quiet = false) => {
    if (Exit.isSuccess(exit)) return exit.value;
    if (!quiet && !Cause.hasInterruptsOnly(exit.cause))
      toast.add({ title: failureOf(exit.cause).reason, color: "error" });
    return null;
  };

  /** A Run's item by reference, read part by part until all of it is here. */
  const wholeAs =
    <A>(as: (whole: Effect.Success<ReturnType<typeof partsOf>>) => A) =>
    (installation: string, runId: string, ref: string, options: ReadOptions = {}) => {
      const whole = partsOf(installation, runId, ref).pipe(Effect.map(as));
      return Effect.runPromiseExit(options.within?.withPermits(1)(whole) ?? whole, {
        signal: options.signal,
      }).then((exit) => read(exit, options.quiet));
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
    textOf: wholeAs((whole) =>
      whole._tag === "Text" ? whole.text : new TextDecoder().decode(joined(whole.parts)),
    ),
    bytesOf: wholeAs((whole) =>
      whole._tag === "Text" ? new TextEncoder().encode(whole.text) : joined(whole.parts),
    ),
  };
};
