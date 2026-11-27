import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Predicate, Result, Schema, Struct } from "effect";
import { VerifySpecSchema } from "./verify-spec";
import { ProjectRef as ProjectRefSchema } from "./project";
import { SavedStart } from "./schedule-model";
import { stringifyJson } from "./json";

const Attachments = Schema.Array(Schema.String).annotate({
  description:
    "Files to give the work, copied into the Run's own directory. In Native chat, paths on this Machine. In Desktop's Flock chat, a path on the computer Desktop runs on or <machine>:<path>; left out, the files of the human's message that asked for it go with it, and [] sends none.",
});

// WARNING: set_verification.command and start.verify run as Collie's own process at the gate, outside agents' permission rules: a deliberate hole.
export const ActionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("update_intent"),
    run: Schema.String,
    change: Schema.Literals(["set-goal", "set-outcome", "add-constraint", "remove-constraint"]),
    patch: Schema.String,
    base_version: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("set_verification"),
    run: Schema.String,
    name: Schema.String,
    // WARNING: absent withdraws the check of that name.
    command: Schema.optionalKey(VerifySpecSchema.mapFields(Struct.omit(["name"]))),
  }),
  Schema.Struct({
    kind: Schema.Literal("remember_verification"),
    run: Schema.String,
    replace: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("deliver"),
    run: Schema.String,
    step: Schema.optional(Schema.String),
    agent: Schema.optionalKey(Schema.String),
    to: Schema.optionalKey(Schema.String),
    text: Schema.String,
    // WARNING: absent means now: a human's message is about the work under way, not the next step.
    mode: Schema.Literals(["boundary", "now", "interrupt"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("now" as const)),
    ),
    attachments: Schema.optionalKey(Attachments),
  }),
  Schema.Struct({
    kind: Schema.Literal("hold"),
    run: Schema.String,
    before: Schema.optionalKey(Schema.String),
    // WARNING: refused at admission rather than dropped, as nothing lifts a hold at a time.
    until: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("release"),
    run: Schema.String,
    before: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("withdraw_note"), run: Schema.String, note: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("stop"), run: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("answer"),
    run: Schema.String,
    choiceId: Schema.String,
    answer: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("start"),
    machine: Schema.optionalKey(Schema.String),
    workflow: Schema.String,
    inputs: Schema.Record(Schema.String, Schema.String),
    decisions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    // WARNING: optional in the schema, but a start without one is refused rather than rooted where the agent asks.
    workspace: Schema.optionalKey(Schema.String),
    // WARNING: a Task named here is started into, never a new one opened beside it.
    task: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    verify: Schema.optionalKey(Schema.Array(VerifySpecSchema)),
    attachments: Schema.optionalKey(Attachments),
  }),
  Schema.Struct({
    kind: Schema.Literal("create_task"),
    instruction: Schema.String,
    label: Schema.optionalKey(Schema.String),
    // WARNING: a Task filed as it is queued can be opened on its Project straight away.
    project: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("project_create"), name: Schema.String }),
  ...Arr.map(
    ["project_star", "project_unstar", "project_archive", "project_restore"] as const,
    (kind) => Schema.Struct({ kind: Schema.Literal(kind), project: Schema.String }),
  ),
  Schema.Struct({
    kind: Schema.Literal("task_file"),
    filings: Schema.Array(
      Schema.Struct({
        task: Schema.String,
        // WARNING: a qualified entry names the owner it is expected on, so a wrong host refuses it.
        installation: Schema.optionalKey(Schema.String),
        // WARNING: absent leaves the Task unassigned; a qualified destination is resolved at its owner.
        project: Schema.optionalKey(ProjectRefSchema),
        // WARNING: the membership the operator saw; a move that names another loses to the one that won.
        expected: Schema.optionalKey(Schema.Finite),
      }),
    ),
  }),
  ...Arr.map(["task_follow", "task_unfollow"] as const, (kind) =>
    Schema.Struct({ kind: Schema.Literal(kind), task: Schema.String }),
  ),
  Schema.Struct({ kind: Schema.Literal("resume"), run: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("followup"),
    run: Schema.String,
    text: Schema.String,
    attachments: Schema.optionalKey(Attachments),
  }),
  Schema.Struct({
    kind: Schema.Literal("take_offer"),
    run: Schema.String,
    offer: Schema.String,
    inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    attachments: Schema.optionalKey(Attachments),
  }),
  Schema.Struct({
    kind: Schema.Literal("navigate"),
    run: Schema.String,
    agent: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("clear_override"),
    run: Schema.String,
    agent: Schema.String,
  }),
  // WARNING: standing authority is not settable here: widening what Runs may do without asking is a grant, and a model that could ask for one would authorise itself.
  Schema.Struct({
    kind: Schema.Literal("update_defaults"),
    change: Schema.Literals(["add-constraint", "remove-constraint"]),
    // WARNING: named rather than inherited: defaults are filed per workspace, so a board confirmation would otherwise write a file no Run reads.
    workspace: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("fork_definition"),
    what: Schema.Literals(["workflow", "persona"]),
    name: Schema.String,
    as: Schema.String,
    layer: Schema.optionalKey(Schema.Literals(["user", "project"])),
    mode: Schema.optionalKey(Schema.Literals(["extends", "copy"])),
  }),
  Schema.Struct({
    kind: Schema.Literal("home_cleanup"),
    machine: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("cleanup"), machine: Schema.optionalKey(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("schedule_add"),
    machine: Schema.optionalKey(Schema.String),
    name: Schema.String,
    cron: Schema.String,
    tz: Schema.optionalKey(Schema.String),
    start: SavedStart.mapFields((fields) => ({
      ...fields,
      workspace: Schema.optionalKey(fields.workspace),
      verify: Schema.optionalKey(fields.verify),
    })),
  }),
  ...Arr.map(["schedule_pause", "schedule_resume", "schedule_remove"] as const, (kind) =>
    Schema.Struct({
      kind: Schema.Literal(kind),
      machine: Schema.optionalKey(Schema.String),
      name: Schema.String,
    }),
  ),
  Schema.Struct({ kind: Schema.Literal("upgrade") }),
  Schema.Struct({
    kind: Schema.Literal("onboard"),
    skip: Schema.optionalKey(Schema.Array(Schema.Literals(["helle", "linear"]))),
  }),
  Schema.Struct({ kind: Schema.Literal("ask_human"), question: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("none"), why: Schema.String }),
]);
export type Action = Schema.Schema.Type<typeof ActionSchema>;
export type ActionKind = Action["kind"];

const KINDS: ReadonlySet<unknown> = new Set(
  Arr.map(ActionSchema.members, ({ fields }) => fields.kind.literal),
);

export const refusedAction = (actions: ReadonlyArray<unknown>) => {
  for (const [at, action] of actions.entries()) {
    const decoded = Schema.decodeUnknownResult(ActionSchema)(action);
    if (Result.isSuccess(decoded)) {
      continue;
    }
    const kind = Predicate.hasProperty(action, "kind") ? action.kind : null;
    return KINDS.has(kind)
      ? `actions[${at}] (kind "${String(kind)}"): ${pipe_(decoded.failure.message, Str.replaceAll(/\s+/g, " "))}`
      : `actions[${at}] has kind ${stringifyJson(kind)}, which is not a kind Collie takes`;
  }
  return null;
};

export const recipientOf = (action: Extract<Action, { kind: "deliver" }>) =>
  action.agent ?? action.to ?? "the agent at work";
