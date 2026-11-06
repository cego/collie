import type { RunRevision } from "../../../../src/board-model";
import type { PlacedTask, DesktopAction } from "../../../src/shared/flock";
import { shownAt, type FlowActionView, type FlowEffect } from "../../../src/shared/flow-actions";

export const useFlowActions = (
  placed: () => PlacedTask,
  follow: (effect: FlowEffect) => void,
  revision: () => RunRevision | undefined = () => undefined,
) => {
  const { run, openLink } = useActions();
  const asking = ref<(Extract<FlowEffect, { kind: "text" }> & { title: string }) | null>(null);
  /** The last act refused because its Step finished after the record showed it. */
  const stale = ref<{ readonly step: string; readonly reason: string } | null>(null);
  const perform = (
    installation: string,
    action: DesktopAction,
    tried?: (done: boolean | null) => void,
  ) => {
    stale.value = null;
    return run(
      installation,
      shownAt(action, revision()),
      undefined,
      undefined,
      () => (placed().asOf === null ? undefined : "its Machine is out of reach"),
      (done, failed) => {
        if (failed?.step !== undefined) stale.value = { step: failed.step, reason: failed.reason };
        tried?.(done);
      },
    );
  };
  const press = (action: FlowActionView, inspect?: () => void) => {
    if (placed().asOf !== null) return;
    const effect = action.effect;
    switch (effect.kind) {
      case "write":
        void perform(effect.installation, effect.write);
        break;
      case "text":
        asking.value = { ...effect, title: action.label };
        break;
      case "url":
        void openLink(effect.url);
        break;
      case "terminal":
      case "part":
        inspect?.();
        follow(effect);
        break;
      case "answer":
      case "proposal":
        inspect?.();
        break;
      default:
        follow(effect);
    }
  };
  const send = (text: string) => {
    const target = asking.value;
    if (target === null) return;
    const deliver = () =>
      perform(target.installation, { ...target.write, text }).then((sent) =>
        sent && target.retry !== undefined
          ? perform(target.installation, { _tag: "Resume", runId: target.retry })
          : sent,
      );
    return target.withdraw === undefined
      ? deliver()
      : perform(target.installation, {
          _tag: "WithdrawNote",
          runId: target.write.runId,
          note: target.withdraw,
        }).then((removed) => (removed ? deliver() : false));
  };
  return { asking, perform, press, send, stale };
};
