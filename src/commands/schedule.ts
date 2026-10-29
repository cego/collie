// `collie schedule`: a Machine's Schedules, added, listed, paused, resumed, removed and moved
// through its host (ADR-0052). Every line names the Machine it is about.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { agentStartRefusal, asOptionText, insideCheckout } from "../agent-start";
import { mutation } from "../envelope";
import type { PluginEnv } from "../env";
import { Herdr } from "../herdr";
import { changeSchedule, flockSchedules, moduleFor, scheduleDoorOn } from "../lifecycle";
import { machineName } from "../peers";
import { moveSchedule } from "../schedule-move";
import type { PlatformServices } from "../platform";
import { err, type Failure, type OpResult } from "../operations";
import {
  SCHEDULE_PROJECTS_ROOT,
  type ScheduleChange,
  changedLine,
  machineOf,
  scheduleLine,
} from "../schedule-model";
import { givenVerifications } from "../verify-spec";
import { answering, cliDoor, parseInput, requestIdFlag, root } from "./shared";

const SCHEDULE_CHECKOUT_FIX = `Name the checkout with --workspace <absolute path>, a workspace's id or label, or ${SCHEDULE_PROJECTS_ROOT}.`;

/**
 * The checkout a Schedule's start names, as a path or `projects-root`: given, or the
 * checkout the command runs in. A workspace's id or label is its checkout's path, since
 * the workspace may be gone by the time the Schedule fires.
 */
const checkoutOf = Effect.fn("schedule.checkoutOf")(function* (
  env: PluginEnv,
  given: string,
): Effect.fn.Return<
  { readonly path: string | null } | { readonly error: OpResult },
  never,
  PlatformServices
> {
  const named = Str.trim(given);
  if (named === SCHEDULE_PROJECTS_ROOT || pipe_(named, Str.startsWith("/"))) return { path: named };
  if (named === "") return { path: (yield* insideCheckout(env.cwd)) ? env.cwd : null };
  const all = yield* new Herdr(env).workspaceList().pipe(Effect.orElseSucceed(() => []));
  const byId = Arr.filter(all, (one) => one.workspaceId === named);
  const matched =
    byId.length > 0
      ? byId
      : Arr.filter(all, (one) => Str.toLowerCase(one.label) === Str.toLowerCase(named));
  const found = matched.length === 1 ? matched[0] : undefined;
  if (found === undefined || found.cwd === "")
    return {
      error: err(
        "invalid_input",
        matched.length > 1
          ? `"${named}" names ${matched.length} workspaces (${Arr.join(
              Arr.map(matched, (one) => one.workspaceId),
              ", ",
            )}); say which`
          : `no workspace id or label is "${named}"; workspaces: ${
              Arr.join(
                Arr.map(all, (one) => one.label),
                ", ",
              ) || "none"
            }. ${SCHEDULE_CHECKOUT_FIX}`,
      ),
    };
  return { path: found.cwd };
});

const nameArg = Argument.String("name").pipe(
  Argument.withDescription(
    "The Schedule's name: lowercase letters, digits and hyphens, at most 40",
  ),
);

/** A change through the host, with its receipt. */
const changing = (
  operation: string,
  requestId: Option.Option<string>,
  change: (
    env: PluginEnv,
  ) => Effect.Effect<ScheduleChange | { readonly refused: OpResult }, never, PlatformServices>,
) =>
  answering((env) =>
    mutation(env, operation, requestId, (request) =>
      Effect.gen(function* () {
        const asked = yield* change(env);
        if ("refused" in asked) return asked.refused;
        const changed = yield* changeSchedule(env, {
          door: yield* cliDoor(env),
          change: asked,
          request,
        });
        if (!changed.ok) return changed;
        return { ok: true as const, data: changed.value, human: changedLine(changed.value) };
      }),
    ),
  );

const scheduleAdd = Command.make(
  "add",
  {
    name: nameArg,
    workflow: Argument.String("workflow").pipe(
      Argument.withDescription("Which Workflow it starts, as `workflow list` names it"),
    ),
    cron: Flag.String("cron").pipe(
      Flag.withDescription(
        'When, as five cron fields: minute hour day-of-month month weekday ("0 7 * * *")',
      ),
    ),
    tz: Flag.String("tz").pipe(
      Flag.withDescription(
        "The IANA time zone the cron expression is read in; this Machine's by default",
      ),
      Flag.optional,
    ),
    paused: Flag.Boolean("paused").pipe(
      Flag.withDescription("Add it paused, to fire only once it is resumed"),
      Flag.withDefault(false),
    ),
    input: Flag.String("input").pipe(
      Flag.withDescription(
        'key=value, repeatable; every Input the Workflow takes, an optional one as ""',
      ),
      Flag.atLeast(0),
    ),
    inputsJson: Flag.String("inputs-json").pipe(
      Flag.withDescription("Every Input at once, as one JSON object"),
      Flag.optional,
    ),
    verify: Flag.String("verify").pipe(
      Flag.withDescription(
        'A check Collie may run to prove its Runs, repeatable: one verify.json entry, {"name","executable","argv","cwd"}',
      ),
      Flag.atLeast(0),
    ),
    requestId: requestIdFlag,
  },
  ({ name, workflow, cron, tz, paused, input, inputsJson, verify, requestId }) =>
    Effect.flatMap(root, (global) =>
      changing("schedule-add", requestId, (env) =>
        Effect.gen(function* () {
          const refused = (failure: OpResult) => ({ refused: failure });
          const parsed = yield* parseInput(input, inputsJson);
          if (!parsed.ok) return refused(parsed.error);
          const given = Rec.fromEntries([
            ...Rec.toEntries(parsed.given.text),
            ...Arr.map(
              Rec.toEntries(parsed.given.json),
              ([key, value]): [string, string] => [key, asOptionText(value)] as const,
            ),
          ]);
          // The shared `--workspace` names the checkout: a path, a workspace, or the Projects root.
          const where = Option.getOrUndefined(global.workspace) ?? given.workspace ?? "";
          const inputs = Rec.fromEntries(
            Arr.filter(Rec.toEntries(given), ([key]) => key !== "workspace"),
          );
          const checks = givenVerifications(verify);
          if (!checks.ok) return refused(err("invalid_input", checks.error));
          const scheduled = (workspace: string) => ({
            change: "add" as const,
            name,
            cron,
            paused,
            start: { workflow, inputs, workspace, verify: checks.specs },
            ...Option.match(tz, { onNone: () => ({}), onSome: (zone) => ({ tz: zone }) }),
          });
          // Another Machine's host checks the start against its own modules and checkout.
          if (env.machine !== undefined) return scheduled(Str.trim(where));
          const checkout = yield* checkoutOf(env, where);
          if ("error" in checkout) return refused(checkout.error);
          const at = checkout.path === SCHEDULE_PROJECTS_ROOT ? null : checkout.path;
          const saved = yield* moduleFor({ ...env, cwd: at ?? env.cwd }, workflow);
          if (saved === null)
            return refused(
              err(
                "workflow_not_found",
                `No workflow module is saved as "${workflow}". \`collie workflow list\` is what this installation has.`,
                { workflow },
              ),
            );
          if ("inputs" in saved) {
            const needed = yield* agentStartRefusal(
              { ...env, cwd: at ?? env.cwd },
              saved,
              { json: {}, text: inputs },
              { named: checkout.path, fix: SCHEDULE_CHECKOUT_FIX },
            );
            if (needed !== null) return refused(needed);
          }
          return scheduled(checkout.path ?? "");
        }).pipe(Effect.orDie),
      ),
    ),
).pipe(
  Command.withDescription("Save a start to be made whenever a cron expression falls due"),
  Command.withExamples([
    {
      command:
        'collie schedule add self-improve-daily --cron "0 7 * * *" self-improve --input improvements=3 --workspace /home/me/collie',
      description: "Start self-improve in a Collie checkout every morning at seven",
    },
  ]),
);

const scheduleList = Command.make("list", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const listed = yield* flockSchedules(env, yield* cliDoor(env));
      if (!listed.ok) return listed;
      const { schedules, machines } = listed.value;
      return {
        ok: true as const,
        data: listed.value,
        human: Arr.join(
          [
            ...(schedules.length === 0
              ? ["No Schedules."]
              : Arr.map(
                  schedules,
                  (entry) => `${machineOf(entry.machine)}\t${scheduleLine(entry)}`,
                )),
            ...Arr.map(machines, ({ machine, note }) => `${machine} is away: ${note}`),
          ],
          "\n",
        ),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Every Machine's Schedules, or the one --machine names: when each fires next and how its last went",
  ),
);

const MOVE_CODES = {
  machine_unreachable: "machine_unreachable",
  schedule_not_found: "invalid_input",
  move_failed: "operation_failed",
  move_incomplete: "operation_failed",
} as const;

const scheduleMove = Command.make(
  "move",
  {
    name: nameArg,
    to: Flag.String("to").pipe(
      Flag.withDescription("The Machine it moves to: a paired Machine's name, or this Machine's"),
    ),
    requestId: requestIdFlag,
  },
  ({ name, to, requestId }) =>
    Effect.flatMap(root, (global) =>
      answering((env) =>
        mutation(env, "schedule-move", requestId, (request) =>
          Effect.gen(function* () {
            const here = machineName();
            const source = env.machine ?? here;
            if (source === to) return err("invalid_input", `"${name}" is on ${to} already.`);
            const door = yield* cliDoor(env);
            const refusals: Array<Failure> = [];
            const keep = (failure: Failure) => void refusals.push(failure);
            const moved = yield* moveSchedule({
              from: yield* scheduleDoorOn(env, source === here ? null : source, door, keep),
              to: yield* scheduleDoorOn(env, to === here ? null : to, door, keep),
              name,
              checkout: Option.getOrUndefined(global.workspace),
              request,
            });
            if (moved.ok) return { ok: true as const, data: moved.moved, human: moved.said };
            const first = refusals[0];
            // A Machine that could not be reached is refused as every --machine is.
            if (moved.code === "machine_unreachable" && first !== undefined) return first;
            return err(MOVE_CODES[moved.code], moved.message, { step: moved.code });
          }),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Move a Schedule to another Machine: added there paused, removed here, then resumed there",
  ),
  Command.withExamples([
    {
      command: "collie schedule move self-improve-daily --to vm --workspace /home/me/collie",
      description: "Fire it on vm from now on, in the checkout vm has",
    },
  ]),
);

const named = (change: "pause" | "resume" | "remove", description: string) =>
  Command.make(change, { name: nameArg, requestId: requestIdFlag }, ({ name, requestId }) =>
    changing(`schedule-${change}`, requestId, () => Effect.succeed({ change, name })),
  ).pipe(Command.withDescription(description));

export const schedule = Command.make("schedule").pipe(
  Command.withDescription("Workflows this Machine's host starts by itself, on a cron expression"),
  Command.withSubcommands([
    scheduleAdd,
    scheduleList,
    scheduleMove,
    named("pause", "Stop a Schedule firing until it is resumed; its Run going now goes on"),
    named("resume", "Fire a paused Schedule again, from its next occurrence, with no catch-up"),
    named("remove", "Remove a Schedule; every Run it started stays"),
  ]),
);
