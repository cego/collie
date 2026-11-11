import * as Arr from "effect/Array";
import { Effect, Option } from "effect";
import type { RunView } from "./engine";
import type { PluginEnv } from "./env";
import { currentOf, linkSaid, linkState } from "./flow";
import { laneFor } from "./flow-read";
import { settledSaid } from "./flow-timing";
import { asksRun } from "./lifecycle";
import { machineName, peersOf } from "./peers";
import type { Peer } from "./peers-model";
import {
  readLinkDeliveries,
  readSentNotices,
  recordLinkDelivery,
  recordSentNotice,
  type RunLinkNotice,
} from "./run-links";
import { factsOfView } from "./runs";
import { epochMs, nowIso } from "./time";

const peerOf = (env: PluginEnv, installation: string) =>
  peersOf(env.stateDir).pipe(
    Effect.map((peers) =>
      Option.getOrUndefined(Arr.findFirst(peers, (one) => one.installation === installation)),
    ),
  );

const send = Effect.fn("RunLinks.send")(function* (
  env: PluginEnv,
  dir: string,
  peer: Peer,
  notice: RunLinkNotice,
) {
  const who = notice.requestedBy;
  const sent = yield* asksRun(
    { ...env, machine: peer.name, pairs: false },
    who.run,
    (client) =>
      client.linkNotice({
        notice,
        request: `link-${notice.machine.installation}-${notice.run}-${notice.phase}`,
      }),
    { origin: "host", from: { run: notice.run, agent: "host", machine: notice.machine } },
  ).pipe(
    Effect.timeoutOption("15 seconds"),
    Effect.orElseSucceed(() => Option.none()),
  );
  const delivered = Option.isSome(sent) && sent.value.ok && sent.value.value;
  yield* recordLinkDelivery(dir, {
    phase: notice.phase,
    state: delivered ? "delivered" : "undelivered",
    at: yield* nowIso,
    note: delivered
      ? `Delivered to ${who.run} on ${peer.name}.`
      : Option.isSome(sent) && !sent.value.ok
        ? sent.value.error.message
        : "Delivery was not confirmed within 15 seconds.",
  }).pipe(Effect.orDie);
});

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
  const peer = yield* peerOf(env, who.machine.installation);
  if (peer === undefined)
    return yield* recordLinkDelivery(dir, {
      phase,
      state: "undelivered",
      at,
      note: `The requesting Machine ${who.machine.name} is no longer paired.`,
    }).pipe(Effect.orDie);
  const stored = Arr.findFirst(yield* readSentNotices(dir), (one) => one.phase === phase);
  if (Option.isSome(stored)) return yield* send(env, dir, peer, stored.value);
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
    said: settledSaid(
      linkSaid({
        ...run,
        finished: phase === "settled" ? at : null,
        mrState: null,
        current:
          Option.getOrUndefined(Arr.findFirst(lane.nodes, (one) => one.id === current?.node))
            ?.said ?? null,
      }),
      epochMs(at),
    ).said,
  };
  yield* recordSentNotice(dir, notice).pipe(Effect.orDie);
  yield* send(env, dir, peer, notice);
});

/** Sends `view`'s undelivered notices to `peer` again; returns how many. */
export const resendRunLinks = Effect.fn("RunLinks.resend")(function* (
  env: PluginEnv,
  view: RunView,
  peer: Peer,
) {
  const dir = `${env.stateDir}/runs/${view.runId}`;
  const tries = yield* readLinkDeliveries(dir);
  const owed = Arr.filter(
    yield* readSentNotices(dir),
    (notice) =>
      notice.requestedBy.machine.installation === peer.installation &&
      !Arr.some(tries, (one) => one.phase === notice.phase && one.state === "delivered"),
  );
  for (const notice of owed) yield* send(env, dir, peer, notice);
  return owed.length;
});
