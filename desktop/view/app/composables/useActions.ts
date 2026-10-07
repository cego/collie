// The board's actions, each asked of the Machine its card is on. What came of one is
// said in a toast, in the host's own words when it said no.

import { AtomRegistry, injectRegistry, useAtomSet } from "@effect/atom-vue";
import { Cause, Effect, Encoding, Exit, Result, type Semaphore, Stream } from "effect";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type {
  ActionFailed,
  DesktopAction,
  Skippable,
  TerminalCommand,
} from "../../../src/shared/flock";
import { FlockClient } from "../flock";

const actAtom = FlockClient.mutation("act");
const offersAtom = FlockClient.mutation("offers");
const workflowsAtom = FlockClient.mutation("workflows");
const openLinkAtom = FlockClient.mutation("openLink");
const goToPaneAtom = FlockClient.mutation("goToPane");
const terminalSendAtom = FlockClient.mutation("terminalSend");
const restartAtom = FlockClient.mutation("restart");
const checkForUpdatesAtom = FlockClient.mutation("checkForUpdates");
const onboardAtom = FlockClient.mutation("onboard");
const addMachineAtom = FlockClient.mutation("addMachine");
const answerHerdrAtom = FlockClient.mutation("answerHerdr");
const removeMachineAtom = FlockClient.mutation("removeMachine");
const syncNowAtom = FlockClient.mutation("syncNow");
const saveGitlabAtom = FlockClient.mutation("saveGitlab");
const saveGitlabHostAtom = FlockClient.mutation("saveGitlabHost");
const saveHelleAtom = FlockClient.mutation("saveHelle");
const setFlockSettingAtom = FlockClient.mutation("setFlockSetting");
const checkHelleAtom = FlockClient.mutation("checkHelle");
const openSlackAtom = FlockClient.mutation("openSlack");
const copyTextAtom = FlockClient.mutation("copyText");
const claudeLoginAtom = FlockClient.mutation("claudeLogin");
const pasteCodeAtom = FlockClient.mutation("pasteCode");

type Failed = ActionFailed | RpcClientError.RpcClientError;

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
  const goToPane = useAtomSet(() => goToPaneAtom, { mode: "promiseExit" });
  const terminalSend = useAtomSet(() => terminalSendAtom, { mode: "promiseExit" });
  const restart = useAtomSet(() => restartAtom, { mode: "promiseExit" });
  const checkForUpdates = useAtomSet(() => checkForUpdatesAtom, { mode: "promiseExit" });
  const onboard = useAtomSet(() => onboardAtom, { mode: "promiseExit" });
  const addMachine = useAtomSet(() => addMachineAtom, { mode: "promiseExit" });
  const answerHerdr = useAtomSet(() => answerHerdrAtom, { mode: "promiseExit" });
  const removeMachine = useAtomSet(() => removeMachineAtom, { mode: "promiseExit" });
  const syncNow = useAtomSet(() => syncNowAtom, { mode: "promiseExit" });
  const saveGitlab = useAtomSet(() => saveGitlabAtom, { mode: "promiseExit" });
  const saveGitlabHost = useAtomSet(() => saveGitlabHostAtom, { mode: "promiseExit" });
  const saveHelle = useAtomSet(() => saveHelleAtom, { mode: "promiseExit" });
  const setFlockSetting = useAtomSet(() => setFlockSettingAtom, { mode: "promiseExit" });
  const checkHelle = useAtomSet(() => checkHelleAtom, { mode: "promiseExit" });
  const openSlack = useAtomSet(() => openSlackAtom, { mode: "promiseExit" });
  const copyText = useAtomSet(() => copyTextAtom, { mode: "promiseExit" });
  const claudeLogin = useAtomSet(() => claudeLoginAtom, { mode: "promiseExit" });
  const pasteCode = useAtomSet(() => pasteCodeAtom, { mode: "promiseExit" });
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
  /** Whether it was kept; what came of it is said. */
  const kept = (exit: Exit.Exit<string, Failed>) => {
    const said = read(exit);
    if (said !== null) toast.add({ title: said, color: "success" });
    return said !== null;
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
    /** Installs Desktop's ready update, which restarts it; a refusal is said in a toast. */
    restart: () =>
      restart({ payload: undefined }).then((exit) => {
        if (Exit.isSuccess(exit)) return;
        const { reason } = failureOf(exit.cause);
        toast.add({ title: `Desktop did not restart to update: ${reason}`, color: "error" });
      }),
    /** What it found arrives on `updatesAtom`. */
    checkForUpdates: () => checkForUpdates({ payload: undefined }),
    openLink: (url: string) => openLink({ payload: { url } }),
    /** Where the pane is and how to attach to it, or null where the host said no. */
    goToPane: (installation: string, runId: string) =>
      goToPane({ payload: { installation, runId } }).then(read),
    /** The Run's live agent's pane, held for as long as the stream runs. */
    terminal: (installation: string, runId: string, cols: number, rows: number) =>
      Stream.unwrap(
        AtomRegistry.getResult(registry, FlockClient.runtime).pipe(
          Effect.map((context) =>
            Stream.unwrap(
              FlockClient.use((client) =>
                Effect.succeed(client("terminal", { installation, runId, cols, rows })),
              ),
            ).pipe(Stream.provideContext(context)),
          ),
        ),
      ),
    /** One command to the open terminal; one sent before it opened or after it ended is dropped. */
    terminalSend: (command: TerminalCommand) => terminalSend({ payload: { command } }),
    offersOf: (installation: string, runId: string) =>
      offers({ payload: { installation, runId } }).then(read),
    workflowsIn: (installation: string, project: string) =>
      workflows({ payload: { installation, project } }).then(read),
    /** The job onboarding that route's Machine, whose progress comes on the board. */
    onboard: (profile: string, skip?: ReadonlyArray<Skippable>) =>
      onboard({ payload: skip === undefined ? { profile } : { profile, skip } }).then(read),
    addMachine: (target: string, label: string, session: string) =>
      addMachine({ payload: { target, label, session } }).then(read),
    answerHerdr: (job: string, yes: boolean) => answerHerdr({ payload: { job, yes } }),
    /** Whether it was kept; what came of giving it to each Machine is said. */
    saveGitlab: (token: string) => saveGitlab({ payload: { token } }).then(kept),
    saveGitlabHost: (host: string) => saveGitlabHost({ payload: { host } }).then(kept),
    saveHelle: (token: string) => saveHelle({ payload: { token } }).then(kept),
    setFlockSetting: (key: string, value: string) =>
      setFlockSetting({ payload: { key, value } }).then(kept),
    /** Who the token belongs to, or why Helle would not say. */
    checkHelle: (token: string) =>
      checkHelle({ payload: { token } }).then((exit) =>
        Exit.isSuccess(exit)
          ? ({ owner: exit.value } as const)
          : ({ refused: failureOf(exit.cause).reason } as const),
      ),
    openSlack: () => openSlack({ payload: undefined }),
    copyText: (text: string) =>
      copyText({ payload: { text } }).then((exit) => {
        if (Exit.isSuccess(exit)) toast.add({ title: `Copied ${text}`, color: "success" });
      }),
    /** The job logging Claude Code in on that route's Machine. */
    claudeLogin: (profile: string) => claudeLogin({ payload: { profile } }).then(read),
    pasteCode: (job: string, code: string) => pasteCode({ payload: { job, code } }),
    syncNow: (profile: string) =>
      syncNow({ payload: { profile } }).then((exit) => {
        const synced = read(exit);
        if (synced !== null)
          toast.add({ title: synced.said, color: synced.failed ? "error" : "success" });
      }),
    removeMachine: (profile: string) =>
      removeMachine({ payload: { profile } }).then((exit) => {
        const said = read(exit);
        if (said !== null) toast.add({ title: said, color: "success" });
      }),
    textOf: wholeAs((whole) =>
      whole._tag === "Text" ? whole.text : new TextDecoder().decode(joined(whole.parts)),
    ),
    bytesOf: wholeAs((whole) =>
      whole._tag === "Text" ? new TextEncoder().encode(whole.text) : joined(whole.parts),
    ),
  };
};
