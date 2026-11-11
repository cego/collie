import * as Arr from "effect/Array";
import { Effect, FileSystem, Layer, Option, Queue, Schedule, Schema, flow, Result } from "effect";
import type { PluginEnv } from "./env";
import { Registry, owesReport, runDir, type CrashPoint, type RunView } from "./engine";
import { Store } from "./store";
import { RunReport } from "./board-model";
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
import { notifyRunLink, resendRunLinks } from "./run-link-delivery";
import type { Peer } from "./peers-model";

const encodeReport = flow(Schema.encodeResult(Schema.fromJsonString(RunReport)), Result.getOrThrow);

export const reportsLayer = (opts: {
  env: PluginEnv;
  installation: string;
  stamp: string;
  crashAt?: CrashPoint;
  linked: Queue.Dequeue<Peer>;
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
      const write = (run: string, report: RunReport) =>
        Effect.gen(function* () {
          const file = `${runDir(env.stateDir, run)}/report.json`;
          yield* fs.writeFileString(`${file}.tmp`, encodeReport(report));
          yield* fs.rename(`${file}.tmp`, file);
        });

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
          if (!answer.ok)
            return undelivered(answer.error.message, answer.error.code === "machine_unreachable");
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
            yield* notifyRunLink(env, opts.installation, view, "settled");
            report = yield* tell(view);
            yield* write(view.runId, report);
          }
          if (view.closes === "reported" && !report.closed) {
            const closed = yield* close(view);
            yield* write(view.runId, { ...report, closed: closed.done, closure: closed.note });
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`${view.runId}'s report could not be finished: ${String(cause)}`),
          ),
        );

      const sweep = Effect.gen(function* () {
        if (!(yield* fs.exists(socketOf(env.stateDir)))) return;
        const views = yield* Effect.forEach(
          Arr.filter(yield* store.runs, owesReport),
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
          Effect.flatMap((answered) => (answered.ok ? Effect.void : Effect.fail(answered.error))),
          Effect.retry({ schedule: Schedule.spaced("500 millis") }),
          Effect.timeoutOption("30 seconds"),
          Effect.map(Option.isSome),
        );

      const resend = (peer: Peer) =>
        Effect.gen(function* () {
          if (!(yield* answers(peer)))
            return yield* Effect.logWarning(
              `notices and reports not sent again: ${peer.name} did not answer once linked`,
            );
          const views = yield* Effect.forEach(
            Arr.filter(yield* store.runs, owesReport),
            (row) => registry.view(row.run),
            { concurrency: 4 },
          );
          let sent = 0;
          for (const view of views) {
            if (view?.requestedBy?.machine.installation !== peer.installation) continue;
            sent += yield* resendRunLinks(env, view, peer);
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
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              `notices and reports not sent again to ${peer.name}: ${String(cause)}`,
            ),
          ),
        );
      yield* Effect.forkScoped(
        Queue.take(opts.linked).pipe(Effect.flatMap(resend), Effect.forever),
      );
    }),
  );
