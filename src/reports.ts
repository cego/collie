import * as Arr from "effect/Array";
import { Effect, FileSystem, Layer, Option, Queue, Schedule } from "effect";
import type { PluginEnv } from "./env";
import { Registry, owesReport, type CrashPoint, type RunView } from "./engine";
import { Store } from "./store";
import type { RunReport } from "./board-model";
import { Agents } from "./agents";
import { readLaunches } from "./launches";
import { asks, asksRun, isSettled } from "./lifecycle";
import { machineName, peersOf } from "./peers";
import { Herdr, herdrFailureReason } from "./herdr";
import { readTask, listTasks, withTaskLock } from "./task";
import { isLaunched, launchedPanes, paneNotOwned } from "./cleanup";
import { currentPid, signalProcess } from "./lock";
import { socketOf } from "./host";
import { nowIso } from "./time";
import { isJsonObject, isString } from "./schema";
import type { Asker } from "./proposals";
import { notifyRunLink, owedRunLinks, resendRunLink } from "./run-link-delivery";
import type { Peer } from "./peers-model";
import { Artefacts } from "./artefacts";
import { factsOfView } from "./runs";

export const reportsLayer = (opts: {
  env: PluginEnv;
  installation: string;
  stamp: string;
  crashAt?: CrashPoint;
  linked: Queue.Dequeue<Peer>;
  /** Whether the link to the peer of that installation is up now. */
  live: (installation: string) => Effect.Effect<boolean>;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const store = yield* Store;
      const agents = yield* Agents;
      const fs = yield* FileSystem.FileSystem;
      const env = { ...opts.env, hostStamp: opts.stamp, pairs: false };
      const herdr = new Herdr(env);
      const ownMachine = { installation: opts.installation, name: machineName() };
      const write = store.reported;

      const close = (view: RunView) =>
        Effect.gen(function* () {
          const stopped = yield* agents.halt(view.runId);
          if (stopped.left.length > 0) return { done: false, note: Arr.join(stopped.left, "; ") };
          if (view.task === null)
            return { done: true, note: "The Run's agents are closed; it has no Task workspace." };
          return yield* withTaskLock(
            view.task,
            Effect.gen(function* () {
              const task = yield* readTask(view.task!);
              if (task === null)
                return { done: true, note: "The Run's agents are closed; its Task is gone." };
              if (task.workspace === null)
                return {
                  done: true,
                  note: "The Run's agents are closed; its Task has no workspace.",
                };
              const tasks = yield* listTasks;
              if (Arr.some(tasks, (one) => one.id !== task.id && one.workspace === task.workspace))
                return { done: true, note: "The workspace is kept: another Task names it." };
              const runs = yield* registry.views(task.id);
              if (Arr.some(runs, (one) => one.runId !== view.runId && !isSettled(one)))
                return { done: true, note: "The workspace is kept: another Run needs it." };
              const workspaces = yield* herdr.workspaceList();
              const open = Option.getOrUndefined(
                Arr.findFirst(workspaces, (one) => one.workspaceId === task.workspace),
              );
              if (open === undefined)
                return { done: true, note: "The Task workspace is already closed." };
              if ("collie_home" in open.tokens)
                return { done: true, note: "The workspace is kept: it is the Home." };
              const panes = yield* herdr.paneList();
              const siblings = yield* launchedPanes(
                Arr.map(
                  Arr.filter(runs, (one) => one.runId !== view.runId),
                  (one) => one.runId,
                ),
              );
              if (
                Arr.some(
                  panes,
                  (pane) => pane.workspaceId === task.workspace && isLaunched(siblings, pane),
                )
              )
                return { done: true, note: "The workspace is kept: another Run has a live agent." };
              const foreign = paneNotOwned(task, panes, yield* launchedPanes([view.runId]));
              if (foreign !== undefined)
                return {
                  done: true,
                  note: `The workspace is kept: pane ${foreign.paneId} was not opened by Collie.`,
                };
              yield* herdr.workspaceClose(task.workspace);
              return { done: true, note: "The Run's agents and Task workspace are closed." };
            }),
          );
        }).pipe(
          Effect.catch((cause) => Effect.succeed({ done: false, note: herdrFailureReason(cause) })),
        );

      const tell = (view: RunView) =>
        Effect.gen(function* () {
          const who = view.requestedBy;
          const at = yield* nowIso;
          const undelivered = (note: string, unreached = false): RunReport => ({
            state: "undelivered",
            at,
            note,
            unreached,
            closed: false,
          });
          if (who === undefined) return undelivered("No agent requested this Run.");
          const peer =
            who.machine.installation === opts.installation
              ? null
              : Option.getOrUndefined(
                  Arr.findFirst(
                    yield* peersOf(env.stateDir),
                    (one) => one.installation === who.machine.installation,
                  ),
                );
          if (peer === undefined)
            return undelivered(`The requesting Machine ${who.machine.name} is no longer paired.`);
          const launches = yield* readLaunches(view.runId);
          const agent = launches.at(-1)?.agent;
          const actor: Asker = {
            origin: agent === undefined ? "host" : "agent",
            from: { run: view.runId, agent: agent ?? "host", machine: ownMachine },
          };
          const status = view.status;
          const summary =
            status.status === "failed"
              ? status.reason
              : status.status === "complete" &&
                  isJsonObject(status.value) &&
                  isString(status.value.summary)
                ? status.value.summary
                : "The Run settled; read its full Output.";
          const text = `${view.runId}: ${status.status}.\n${summary}\nFull Output: collie run show ${view.runId}`;
          const reached = peer === null ? env : { ...env, machine: peer.name };
          const sent = yield* asksRun(
            reached,
            who.run,
            (client) =>
              client.steer({
                runId: who.run,
                agent: who.agent,
                text,
                request: `report-${view.runId}`,
                mode: "boundary",
              }),
            actor,
          ).pipe(Effect.timeoutOption("15 seconds"));
          if (Option.isNone(sent))
            return undelivered("Delivery was not confirmed within 15 seconds.", true);
          const answer = sent.value;
          if (!answer.ok) return undelivered(answer.error.message, answer.unreached === true);
          if (!answer.value.delivered)
            return undelivered(answer.value.detail || "The requesting agent is gone.");
          if (opts.crashAt === "reported") yield* signalProcess(yield* currentPid, "SIGKILL");
          return {
            state: "delivered" as const,
            at,
            note: `Delivered to ${who.agent} of ${who.run} on ${who.machine.name}.`,
            closed: false,
          };
        });

      const finish = (view: RunView) =>
        Effect.gen(function* () {
          let report = view.report;
          if (report === undefined) {
            const catalogue = yield* Artefacts;
            yield* catalogue.prepareReports(factsOfView(env.stateDir, view));
            const reading = { ...view, narratives: yield* catalogue.reports(view.runId) };
            yield* notifyRunLink(env, opts.installation, reading, "settled");
            report = yield* tell(reading);
            yield* write(view.runId, report);
          }
          if (view.closes === "reported" && !report.closed) {
            const closed = yield* close(view);
            yield* write(view.runId, { ...report, closed: closed.done, closure: closed.note });
          }
        });

      const sweep = Effect.gen(function* () {
        if (!(yield* fs.exists(socketOf(env.stateDir)))) return;
        const views = yield* Effect.forEach(
          Arr.filter(yield* store.reportsPending, owesReport),
          (row) => registry.view(row.run),
          { concurrency: 4 },
        );
        yield* Effect.forEach(
          Arr.filter(
            views,
            (view): view is RunView =>
              view !== null &&
              isSettled(view) &&
              (view.report === undefined || (view.closes === "reported" && !view.report.closed)),
          ),
          finish,
          { concurrency: 4, discard: true },
        );
      });
      yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced("1 second"))));

      const retell = (view: RunView, prior: RunReport) =>
        Effect.gen(function* () {
          const { state, at, note, tries = [], closed, closure } = prior;
          const report = { ...(yield* tell(view)), tries: [...tries, { state, at, note }], closed };
          yield* write(view.runId, closure === undefined ? report : { ...report, closure });
        });

      // A peer's link is up before its host serves calls over it.
      const answers = (peer: Peer) =>
        asks({ ...env, machine: peer.name }, (client) => client.identity()).pipe(
          Effect.timeoutOption("5 seconds"),
          Effect.map((answered) => Option.isSome(answered) && answered.value.ok),
        );

      /** Sends again what `peer` is owed; true once nothing that may still reach it is. */
      const resend = (peer: Peer) =>
        Effect.gen(function* () {
          const views = yield* Effect.forEach(
            Arr.filter(yield* store.runs, owesReport),
            (row) => registry.view(row.run),
            { concurrency: 4 },
          );
          const owed = [];
          for (const view of views) {
            if (view?.requestedBy?.machine.installation !== peer.installation) continue;
            const notices = yield* owedRunLinks(env, view, peer);
            const report = view.report;
            const untold =
              isSettled(view) &&
              (report === undefined ||
                (report.state === "undelivered" && report.unreached === true));
            if (notices.length > 0 || untold) owed.push({ view, notices });
          }
          if (owed.length === 0) {
            yield* Effect.logInfo(`${peer.name} is linked: nothing is owed to it`);
            return true;
          }
          if (!(yield* answers(peer))) return false;
          let sent = 0;
          for (const { view, notices } of owed) {
            for (const notice of notices) yield* resendRunLink(env, view, peer, notice);
            sent += notices.length;
            const report = view.report;
            if (
              report?.state === "undelivered" &&
              report.unreached === true &&
              // A close still owed is the sweep's to write.
              (view.closes !== "reported" || report.closed)
            ) {
              yield* retell(view, report);
              sent += 1;
            }
          }
          yield* Effect.logInfo(`${peer.name} is linked: ${sent} notices and reports sent again`);
          return false;
        });

      // Each linked peer is owed a resend until nothing is left, or its link drops again.
      const due = new Map<string, Peer>();
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const linked = yield* due.size === 0
            ? Effect.asSome(Queue.take(opts.linked))
            : Queue.take(opts.linked).pipe(Effect.timeoutOption("5 seconds"));
          if (Option.isSome(linked)) due.set(linked.value.installation, linked.value);
          for (const [installation, peer] of due)
            if (!(yield* opts.live(installation)) || (yield* resend(peer)))
              due.delete(installation);
        }).pipe(Effect.forever),
      );
    }),
  );
