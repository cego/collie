// Everything a model may propose, as one closed schema. No effects and nothing Bun-only:
// Desktop's main process decodes chat's actions with it too.

import { Effect, Schema, Struct } from "effect";
import { VerifySpecSchema } from "./verify-spec";

/** Files the work is given, as paths on the Machine of the host that carries it out. */
const Attachments = Schema.Array(Schema.String).annotate({
  description:
    "Files to give the work, copied into the Run's own directory. In Native chat, paths on this Machine. In Desktop's Flock chat, a path on the computer Desktop runs on or <machine>:<path>; left out, the files of the human's message that asked for it go with it, and [] sends none.",
});

/**
 * Everything the model may propose, and nothing else. A closed union is the security
 * boundary, with one deliberate hole: `set_verification.command` and `start.verify` are an
 * executable and its arguments that Collie spawns itself at the gate, outside any agent's
 * permission rules. Chat's `collie_propose` carries `set_verification` out in the same call,
 * with no yes, so what chat read in the repository decides what Collie runs. The human
 * reads what ran in the merge request, before it lands (ADR-0011, 2026-09-29).
 */
export const ActionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("update_intent"),
    run: Schema.String,
    /** Which amendment this is. `patch` is the goal, the constraint, or its id. */
    change: Schema.Literals(["set-goal", "add-constraint", "remove-constraint"]),
    patch: Schema.String,
    base_version: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("set_verification"),
    run: Schema.String,
    /** The check's name; a grant of a name already there replaces it. */
    name: Schema.String,
    /** What Collie runs for it; absent withdraws the check of that name. */
    command: Schema.optionalKey(VerifySpecSchema.mapFields(Struct.omit(["name"]))),
  }),
  /** The Run's checks, kept as its repository's own for every Run started there later. */
  Schema.Struct({
    kind: Schema.Literal("remember_verification"),
    run: Schema.String,
    /** Overwrite checks already kept for that repository. */
    replace: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("deliver"),
    run: Schema.String,
    agent: Schema.String,
    text: Schema.String,
    /** Absent is `now`: a human's message is about the work under way, not the next step. */
    mode: Schema.Literals(["boundary", "now", "interrupt"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("now" as const)),
    ),
    attachments: Schema.optionalKey(Attachments),
  }),
  Schema.Struct({
    kind: Schema.Literal("hold"),
    run: Schema.String,
    /** Refused at admission rather than dropped: nothing lifts a hold at a time. */
    until: Schema.optionalKey(Schema.String),
    /** Why, in the human's own words. */
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("release"), run: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("stop"), run: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("answer"),
    run: Schema.String,
    choiceId: Schema.String,
    answer: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("start"),
    workflow: Schema.String,
    inputs: Schema.Record(Schema.String, Schema.String),
    decisions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    /**
     * Which checkout the Run is for: a workspace id, its label, the path of the checkout
     * itself or its repository's name under the Projects root — a checkout no workspace is
     * open on gets one opened — or `projects-root`.
     * Required: an agent's start is refused without one rather than rooted where it asks.
     */
    workspace: Schema.optionalKey(Schema.String),
    /**
     * Keep the Run in that workspace, as its Task, rather than open a workspace for its
     * worktree: what someone asking from a workspace usually means by "start it here".
     */
    here: Schema.optionalKey(Schema.Boolean),
    /** Checks Collie may run to prove it, over the project's and the user's verify.json. */
    verify: Schema.optionalKey(Schema.Array(VerifySpecSchema)),
    attachments: Schema.optionalKey(Attachments),
  }),
  Schema.Struct({ kind: Schema.Literal("resume"), run: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("followup"),
    run: Schema.String,
    text: Schema.String,
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
  /**
   * The standing constraints every Run started in one workspace afterwards is held to.
   * Setting the standing *authority* is not here: widening what Runs may do without
   * asking is a grant, and a model that could ask for one would be authorising itself.
   */
  Schema.Struct({
    kind: Schema.Literal("update_defaults"),
    change: Schema.Literals(["add-constraint", "remove-constraint"]),
    /**
     * Whose new Runs this changes. Named rather than inherited, for the reason `start`
     * names one: defaults are filed per workspace, and a confirmation carried out by the
     * board would otherwise write the Home's — a file no Run ever reads.
     */
    workspace: Schema.String,
    /** The constraint in the human's words to add, or the id of the one to remove. */
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("fork_definition"),
    what: Schema.Literals(["workflow", "persona"]),
    name: Schema.String,
    /** What the fork is called. */
    as: Schema.String,
    layer: Schema.optionalKey(Schema.Literals(["user", "project"])),
    mode: Schema.optionalKey(Schema.Literals(["extends", "copy"])),
  }),
  Schema.Struct({ kind: Schema.Literal("home_cleanup") }),
  Schema.Struct({ kind: Schema.Literal("upgrade") }),
  Schema.Struct({
    kind: Schema.Literal("onboard"),
    /** The default steps this Machine goes without. */
    skip: Schema.optionalKey(Schema.Array(Schema.Literals(["helle", "linear"]))),
  }),
  Schema.Struct({ kind: Schema.Literal("ask_human"), question: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("none"), why: Schema.String }),
]);
export type Action = Schema.Schema.Type<typeof ActionSchema>;
export type ActionKind = Action["kind"];
