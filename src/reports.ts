import { Effect, FileSystem, Layer, Option, Schedule, Schema } from "effect";
import type { PluginEnv } from "./env";
import { Registry, owesReport, runDir, type CrashPoint, type RunView } from "./engine";
import { Store } from "./store";
import { RunReport } from "./board-model";
import { Agents } from "./agents";
import { readLaunches } from "./launches";
import { asksRun, isSettled } from "./lifecycle";
import { machineName, peersOf } from "./peers";
import { Herdr, herdrFailureReason } from "./herdr";
import { readTask, listTasks, withTaskLock } from "./task";
import { isLaunched, launchedPanes, paneNotOwned } from "./cleanup";
import { currentPid, signalProcess } from "./lock";
import { socketOf } from "./host";
import { nowIso } from "./time";
import { isJsonObject, isString } from "./schema";
import type { Asker } from "./proposals";
import { notifyRunLink } from "./run-link-delivery";

const encodeReport = Schema.encodeSync(Schema.fromJsonString(RunReport));

export const reportsLayer = (opts: {
  env: PluginEnv;
  installation: string;
  stamp: string;
  crashAt?: CrashPoint;
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
          if (stopped.left.length > 0) return { done: false, note: stopped.left.join("; ") };
          if (view.task === null)
            return { done: true, note: "The Run's agents are closed; it has no Task workspace." };
          return yield* withTaskLock(
            env.stateDir,
            view.task,
            Effect.gen(function* () {
              const task = yield* readTask(env.stateDir, view.task!);
              if (task === null)
                return { done: true, note: "The Run's agents are closed; its Task is gone." };
              const tasks = yield* listTasks(env.stateDir);
              if (tasks.some((one) => one.id !== task.id && one.workspace === task.workspace))
                return { done: true, note: "The workspace is kept: another Task names it." };
              const runs = yield* registry.views(task.id);
              if (runs.some((one) => one.runId !== view.runId && !isSettled(one)))
                return { done: true, note: "The workspace is kept: another Run needs it." };
              const workspaces = yield* herdr.workspaceList();
              const open = workspaces.find((one) => one.workspaceId === task.workspace);
              if (open === undefined)
                return { done: true, note: "The Task workspace is already closed." };
              if ("collie_home" in open.tokens)
                return { done: true, note: "The workspace is kept: it is the Home." };
              const panes = yield* herdr.paneList();
              const siblings = yield* launchedPanes(
                env.stateDir,
                runs.filter((one) => one.runId !== view.runId).map((one) => one.runId),
              );
              if (
                panes.some(
                  (pane) => pane.workspaceId === task.workspace && isLaunched(siblings, pane),
                )
              )
                return { done: true, note: "The workspace is kept: another Run has a live agent." };
              const foreign = paneNotOwned(
                task,
                panes,
                yield* launchedPanes(env.stateDir, [view.runId]),
              );
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
          const at = yield* nowIso();
          const undelivered = (note: string): RunReport => ({
            state: "undelivered",
            at,
            note,
            closed: false,
          });
          if (who === undefined) return undelivered("No agent requested this Run.");
          const peer =
            who.machine.installation === opts.installation
              ? null
              : (yield* peersOf(env.stateDir)).find(
                  (one) => one.installation === who.machine.installation,
                );
          if (peer === undefined)
            return undelivered(`The requesting Machine ${who.machine.name} is no longer paired.`);
          const launches = yield* readLaunches(env.stateDir, view.runId);
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
            return undelivered("Delivery was not confirmed within 15 seconds.");
          const answer = sent.value;
          if (!answer.ok) return undelivered(answer.error.message);
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
          (yield* store.runs).filter(owesReport),
          (row) => registry.view(row.run),
          { concurrency: 4 },
        );
        yield* Effect.forEach(
          views.filter(
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
    }),
  );
