import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Option, Schema } from "effect";
import type { PluginEnv } from "./env";
import { runDir } from "./engine";
import type { RunView } from "./engine";
import { asks, asksArtefactRun, asksRun, hostTasks } from "./lifecycle";
import type { Door } from "./lifecycle";
import { withArtefacts } from "./artefact-client";
import { readAudit } from "./audit";
import type { AuditLine } from "./audit";
import { recordsReadLayer } from "./records";
import { readIntent } from "./intent";
import { err } from "./operations";
import type { Failure } from "./operations";
import { linesOf, linesError, wholeText } from "./text-lines";
import type { LinesAsked } from "./text-lines";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

export type RunScope = { readonly task: string | null; readonly caller: string | null };

const steered = (line: AuditLine, id: string) =>
  (line.operation === "deliver" || line.operation === "steer") &&
  pipe_(textOf(line.asked), Str.includes(id));

const textOf = (asked: Schema.Json | undefined) =>
  Option.match(Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))(asked), {
    onNone: () => "",
    onSome: (said) => said.text,
  });

const callerReaches = Effect.fn("collie.callerReaches")(function* (
  env: PluginEnv,
  view: RunView,
  caller: string | null,
) {
  if (caller === null) {
    return false;
  }
  if (view.parent === caller || view.requestedBy?.run === caller) {
    return true;
  }
  const trail = yield* readAudit(runDir(env.stateDir, caller)).pipe(
    Effect.provide(recordsReadLayer(env.stateDir)),
    Effect.orElseSucceed(() => []),
  );
  if (Arr.some(trail, (line) => steered(line, view.runId))) {
    return true;
  }
  const intent = yield* readIntent(runDir(env.stateDir, caller)).pipe(
    Effect.provide(recordsReadLayer(env.stateDir)),
    Effect.orElseSucceed(() => null),
  );
  if (pipe_(intent?.goal ?? "", Str.includes(view.runId))) {
    return true;
  }
  const own = yield* asks(env, (client) => client.run({ runId: caller }));
  if (!own.ok || own.value === null) {
    return false;
  }
  const inputs = yield* Schema.encodeEffect(UnknownJson)(own.value.input).pipe(
    Effect.orElseSucceed(() => ""),
  );
  return pipe_(inputs, Str.includes(view.runId));
});

export const outOfReach = Effect.fn("collie.outOfReach")(
  function* (env: PluginEnv, view: RunView, machine: string | null, scope: RunScope) {
    if (machine !== null || scope.task === null || view.task === scope.task) {
      return null;
    }
    if (yield* callerReaches(env, view, scope.caller)) {
      return null;
    }
    const workspace =
      view.task === null
        ? null
        : (Option.getOrUndefined(
            Arr.findFirst(yield* hostTasks(env), (task) => task.id === view.task),
          )?.workspace ?? null);
    const where = view.task === null ? "in no task" : `in task "${view.task}"`;
    const reach =
      workspace === null ? "no workspace reaches it." : `\`--workspace ${workspace}\` reaches it.`;
    return err(
      "run_outside_task",
      `Run "${view.runId}" is ${where}, not task "${scope.task}": ${reach}`,
      { run: view.runId, task: view.task, workspace },
    );
  },
  Effect.catchTag("HostUnread", (unread) =>
    Effect.succeed<Failure>({ ok: false, error: unread.error }),
  ),
);

export const readRunLines = Effect.fn("RunRead.readRunLines")(function* (
  env: PluginEnv,
  scope: RunScope,
  runId: string,
  ref: string,
  asked: LinesAsked,
) {
  const badPattern = linesError(asked);
  if (badPattern !== null) {
    return err("invalid_input", badPattern);
  }
  const found = yield* asksRun(env, runId, (client) => client.run({ runId }));
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
  }
  const refused = yield* outOfReach(env, found.value, found.machine, scope);
  if (refused !== null) {
    return refused;
  }
  const read = yield* asks({ ...env, machine: found.machine ?? undefined }, (client) =>
    wholeText((offset) => client.runFile({ runId, ref, offset })),
  );
  if (!read.ok) {
    return read;
  }
  if (read.value === null) {
    return err(
      "invalid_input",
      `${ref} is not text: it is read by bytes, not by line, in Desktop or with collie run artefact read.`,
    );
  }
  return { ok: true as const, data: linesOf(ref, read.value, asked) };
});

export const readArtefactLines = (
  env: PluginEnv,
  runId: string,
  id: string,
  revision: number,
  asked: LinesAsked,
  door?: Door,
) =>
  asksArtefactRun(
    env,
    runId,
    (client, runId) =>
      withArtefacts(
        client.board(),
        wholeText((offset) => client.artefactRead({ runId, id, revision, offset })),
      ),
    door,
  ).pipe(
    Effect.map((read) =>
      read.ok
        ? {
            ...read,
            value: read.value === null ? null : linesOf(`${id}@${revision}`, read.value, asked),
          }
        : read,
    ),
  );
