import * as Arr from "effect/Array";
import { Effect, Option } from "effect";
import type { RunView } from "./engine";
import type { PluginEnv } from "./env";
import { currentOf, linkSaid, linkState } from "./flow";
import { laneFor } from "./flow-read";
import { asksRun } from "./lifecycle";
import { machineName, peersOf } from "./peers";
import { readLinkDeliveries, recordLinkDelivery, type RunLinkNotice } from "./run-links";
import { factsOfView } from "./runs";
import { nowIso } from "./time";

export const notifyRunLink = Effect.fn("RunLinks.notify")(function* (
  env: PluginEnv,
  installation: string,
  view: RunView,
  phase: RunLinkNotice["phase"],
) {
  const who = view.requestedBy;
  if (who === undefined || who.machine.installation === installation) return;
  const dir = `${env.stateDir}/runs/${view.runId}`;
  if (Arr.some(yield* readLinkDeliveries(dir), (one) => one.phase === phase)) return;
  const at = yield* nowIso;
  const peer = Option.getOrUndefined(
    Arr.findFirst(
      yield* peersOf(env.stateDir),
      (one) => one.installation === who.machine.installation,
    ),
  );
  let state: "delivered" | "undelivered" = "undelivered";
  let note = `The requesting Machine ${who.machine.name} is no longer paired.`;
  if (peer !== undefined) {
    const run = factsOfView(env.stateDir, view);
    const lane = yield* laneFor(env, run);
    const current = currentOf(lane);
    const notice: RunLinkNotice = {
      requestedBy: who,
      run: view.runId,
      workflow: view.workflow,
      machine: { installation, name: machineName() },
      phase,
      state: linkState(run.state),
      at,
      said: linkSaid({
        ...run,
        finished: phase === "settled" ? at : null,
        mrState: null,
        current:
          Option.getOrUndefined(Arr.findFirst(lane.nodes, (one) => one.id === current?.node))
            ?.said ?? null,
      }),
    };
    const sent = yield* asksRun(
      { ...env, machine: peer.name, pairs: false },
      who.run,
      (client) =>
        client.linkNotice({ notice, request: `link-${installation}-${view.runId}-${phase}` }),
      { origin: "host", from: { run: view.runId, agent: "host", machine: notice.machine } },
    ).pipe(
      Effect.timeoutOption("15 seconds"),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(sent) && sent.value.ok && sent.value.value) {
      state = "delivered";
      note = `Delivered to ${who.run} on ${peer.name}.`;
    } else
      note =
        Option.isSome(sent) && !sent.value.ok
          ? sent.value.error.message
          : "Delivery was not confirmed within 15 seconds.";
  }
  yield* recordLinkDelivery(dir, { phase, state, at, note }).pipe(Effect.orDie);
});
