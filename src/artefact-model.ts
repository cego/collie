import { Schema } from "effect";

export const ArtefactDate = Schema.Struct({
  at: Schema.String,
  provenance: Schema.String,
});
export const Artefact = Schema.Struct({
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
});
export type Artefact = typeof Artefact.Type;
export const ArtefactCollection = Schema.Struct({ items: Schema.Array(Artefact) });
export type ArtefactCollection = typeof ArtefactCollection.Type;
