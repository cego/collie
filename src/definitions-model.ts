import { Schema } from "effect";
import { ConnectionUse } from "./connection-model";

export const LAYERS = ["project", "user", "shipped"] as const;
export type EntryLayer = (typeof LAYERS)[number];

export const Declared = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  strategy: Schema.NullOr(Schema.String),
  schema: Schema.NullOr(Schema.Json),
  limits: Schema.Array(Schema.String),
});
export type Declared = typeof Declared.Type;

export const Fault = Schema.Struct({
  id: Schema.String,
  layer: Schema.Literals(LAYERS),
  path: Schema.String,
  message: Schema.String,
});
export type Fault = typeof Fault.Type;

export const Drawn = Schema.Struct({
  schema: Schema.NullOr(Schema.Json),
  limits: Schema.Array(Schema.String),
});

export const Described = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  layer: Schema.Literals(LAYERS),
  path: Schema.String,
  inputs: Schema.Array(Declared),
  options: Schema.Array(Schema.Struct({ name: Schema.String, meaning: Schema.String })),
  success: Drawn,
  error: Drawn,
  metadata: Schema.Json,
  broken: Schema.NullOr(Schema.String),
});
export type Described = typeof Described.Type;

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

export const HostDefinitions = Schema.Struct({
  connectionUses: Schema.optionalKey(Schema.Array(ConnectionUse)),
  workflows: Schema.Array(Schema.Struct({ ...Described.fields, files: Schema.Array(ModuleFile) })),
  problems: Schema.Array(Fault),
  personas: Schema.Array(PersonaView),
  errors: Schema.Array(Schema.String),
});
export type HostDefinitions = typeof HostDefinitions.Type;

export const SharedDefinition = Schema.Struct({
  path: Schema.String,
  base64: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type SharedDefinition = typeof SharedDefinition.Type;
