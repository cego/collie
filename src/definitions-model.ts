// What a Machine's host says its Workflows and Personas are, as Schemas a front door shares.
// Pure, so Desktop reads the same shapes the CLI and chat are given.

import { Schema } from "effect";
import { ConnectionUse } from "./connection-model";

export const LAYERS = ["project", "user", "shipped"] as const;
export type EntryLayer = (typeof LAYERS)[number];

/**
 * One Input a module declares, as a front door needs it: what to call it, whether it may
 * be left out, how it is inferred, and what it will take. The drawing is what lets a
 * picker offer a menu for a closed set or a yes/no for a boolean rather than a text box.
 */
export const Declared = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  /** The strategy that infers this one, from the module's own hints; null for neither. */
  strategy: Schema.NullOr(Schema.String),
  /** The field's schema as JSON Schema, or null where it would not draw. */
  schema: Schema.NullOr(Schema.Json),
  /** Each place the drawing says less than the schema does; the schema still holds. */
  limits: Schema.Array(Schema.String),
});
export type Declared = typeof Declared.Type;

/** An id nothing can be run under, and the file that is why. */
export const Fault = Schema.Struct({
  id: Schema.String,
  layer: Schema.Literals(LAYERS),
  path: Schema.String,
  message: Schema.String,
});
export type Fault = typeof Fault.Type;

/** A schema as a front door draws it, and each place the drawing says less than it does. */
export const Drawn = Schema.Struct({
  schema: Schema.NullOr(Schema.Json),
  limits: Schema.Array(Schema.String),
});

/** One module, in the shape every front door reads it in. */
export const Described = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  layer: Schema.Literals(LAYERS),
  path: Schema.String,
  inputs: Schema.Array(Declared),
  /** What the host settles beside the payload; a module may not declare one of these. */
  options: Schema.Array(Schema.Struct({ name: Schema.String, meaning: Schema.String })),
  success: Drawn,
  error: Drawn,
  /** Hints, outcome and offers as data: the author's closures stay in the module. */
  metadata: Schema.Json,
  /** Why the module would not construct, or null. Constructing it starts no Run. */
  broken: Schema.NullOr(Schema.String),
});
export type Described = typeof Described.Type;

/** One Persona as `persona show` gives it, merged across the Layers below it. */
export const PersonaView = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  layer: Schema.Literals(["baseline", "user", "project"]),
  path: Schema.String,
  extends: Schema.NullOr(Schema.String),
});
export type PersonaView = typeof PersonaView.Type;

export const ModuleFile = Schema.Struct({ path: Schema.String, text: Schema.String });

/** Every Workflow and Persona in a host's shipped and user Layers. */
export const HostDefinitions = Schema.Struct({
  connectionUses: Schema.optionalKey(Schema.Array(ConnectionUse)),
  workflows: Schema.Array(Schema.Struct({ ...Described.fields, files: Schema.Array(ModuleFile) })),
  problems: Schema.Array(Fault),
  personas: Schema.Array(PersonaView),
  errors: Schema.Array(Schema.String),
});
export type HostDefinitions = typeof HostDefinitions.Type;

/** One file of the user Layer a Flock shares, as its latest edit. */
export const SharedDefinition = Schema.Struct({
  /** Where it is in the user directory, such as `workflows/plan.workflow.ts`. */
  path: Schema.String,
  /** Its bytes in base64, or null where the edit removed it. */
  base64: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type SharedDefinition = typeof SharedDefinition.Type;
