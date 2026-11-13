import { Schema } from "effect";

export const ArtefactDate = Schema.Struct({
  at: Schema.String,
  provenance: Schema.String,
});
export const Artefact = Schema.Struct({
  installation: Schema.optionalKey(Schema.String),
  id: Schema.String,
  run: Schema.String,
  kind: Schema.String,
  role: Schema.String,
  title: Schema.String,
  ref: Schema.String,
  source: Schema.String,
  mediaType: Schema.String,
  size: Schema.Int,
  revision: Schema.Int,
  digest: Schema.String,
  created: Schema.optionalKey(Schema.NullOr(ArtefactDate)),
  updated: Schema.optionalKey(Schema.NullOr(ArtefactDate)),
  registeredAt: Schema.String,
  observedAt: Schema.String,
  detectedAt: Schema.String,
  seen: Schema.NullOr(Schema.Struct({ revision: Schema.Int, at: Schema.String })),
  sourceAvailability: Schema.String,
  retainedAvailability: Schema.String,
  reason: Schema.NullOr(Schema.String),
  metadata: Schema.optionalKey(Schema.Json),
  tracking: Schema.optionalKey(Schema.Literals(["local", "snapshot"])),
  registeredBy: Schema.optionalKey(Schema.Json),
  pending: Schema.optionalKey(Schema.Boolean),
  stale: Schema.optionalKey(Schema.Boolean),
});
export type Artefact = typeof Artefact.Type;
export const ArtefactCollection = Schema.Struct({ items: Schema.Array(Artefact) });
export type ArtefactCollection = typeof ArtefactCollection.Type;

export const RegisterFile = Schema.Struct({
  path: Schema.String,
  id: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["file", "asset"])),
  role: Schema.optional(Schema.String),
  snapshot: Schema.optional(Schema.Boolean),
});
export type RegisterFile = typeof RegisterFile.Type;
export const ArtefactRegistered = Schema.Struct({
  address: Schema.Struct({ installation: Schema.String, run: Schema.String, id: Schema.String }),
  item: Artefact,
  retained: Schema.Struct({ revision: Schema.Int, digest: Schema.String, size: Schema.Int }),
});
