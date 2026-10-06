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
const openLinkAtom = FlockClient.mutation("openLink");
const restartAtom = FlockClient.mutation("restart");
const onboardAtom = FlockClient.mutation("onboard");
const addMachineAtom = FlockClient.mutation("addMachine");
const answerHerdrAtom = FlockClient.mutation("answerHerdr");
const removeMachineAtom = FlockClient.mutation("removeMachine");
const saveGitlabAtom = FlockClient.mutation("saveGitlab");
const saveHelleAtom = FlockClient.mutation("saveHelle");
const claudeLoginAtom = FlockClient.mutation("claudeLogin");
const pasteCodeAtom = FlockClient.mutation("pasteCode");

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
  const restart = useAtomSet(() => restartAtom, { mode: "promiseExit" });
  const onboard = useAtomSet(() => onboardAtom, { mode: "promiseExit" });
  const addMachine = useAtomSet(() => addMachineAtom, { mode: "promiseExit" });
  const answerHerdr = useAtomSet(() => answerHerdrAtom, { mode: "promiseExit" });
  const removeMachine = useAtomSet(() => removeMachineAtom, { mode: "promiseExit" });
  const saveGitlab = useAtomSet(() => saveGitlabAtom, { mode: "promiseExit" });
  const saveHelle = useAtomSet(() => saveHelleAtom, { mode: "promiseExit" });
  const claudeLogin = useAtomSet(() => claudeLoginAtom, { mode: "promiseExit" });
  const pasteCode = useAtomSet(() => pasteCodeAtom, { mode: "promiseExit" });

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
    /** Installs Desktop's ready update, which restarts it; a refusal is said in a toast. */
    restart: () =>
      restart({ payload: undefined }).then((exit) => {
        if (Exit.isSuccess(exit)) return;
        const { reason } = failureOf(exit.cause);
        toast.add({ title: `Desktop did not restart to update: ${reason}`, color: "error" });
      }),
    openLink: (url: string) => openLink({ payload: { url } }),
    offersOf: (installation: string, runId: string) =>
      offers({ payload: { installation, runId } }).then(read),
    workflowsIn: (installation: string, project: string) =>
      workflows({ payload: { installation, project } }).then(read),
    /** The job onboarding that route's Machine, whose progress comes on the board. */
    onboard: (profile: string) => onboard({ payload: { profile } }).then(read),
    addMachine: (target: string, label: string, session: string) =>
      addMachine({ payload: { target, label, session } }).then(read),
    answerHerdr: (job: string, yes: boolean) => answerHerdr({ payload: { job, yes } }),
    /** Whether it was kept; what came of giving it to each Machine is said. */
    saveGitlab: (token: string) =>
      saveGitlab({ payload: { token } }).then((exit) => {
        const said = read(exit);
        if (said !== null) toast.add({ title: said, color: "success" });
        return said !== null;
      }),
    saveHelle: (url: string, token: string) =>
      saveHelle({ payload: { url, token } }).then((exit) => {
        const said = read(exit);
        if (said !== null) toast.add({ title: said, color: "success" });
        return said !== null;
      }),
    /** The job logging Claude Code in on that route's Machine. */
    claudeLogin: (profile: string) => claudeLogin({ payload: { profile } }).then(read),
    pasteCode: (job: string, code: string) => pasteCode({ payload: { job, code } }),
    removeMachine: (profile: string) =>
      removeMachine({ payload: { profile } }).then((exit) => {
        const said = read(exit);
        if (said !== null) toast.add({ title: said, color: "success" });
      }),
  };
};
