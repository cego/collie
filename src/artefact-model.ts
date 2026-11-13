import { Schema } from "effect";
import * as Arr from "effect/Array";

export const ArtefactDate = Schema.Struct({
  at: Schema.String,
  provenance: Schema.String,
});
/** What a provider said of its resource: reported by a caller, or verified by a reader. */
export const ProviderObservation = Schema.Struct({
  name: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  resource: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  provenance: Schema.String,
  observedAt: Schema.String,
});
export type ProviderObservation = typeof ProviderObservation.Type;
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
  description: Schema.optionalKey(Schema.String),
  /** The registered destination; absent where none was given. */
  url: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(ProviderObservation),
  /** Where the retained export of an external resource is read from. */
  export: Schema.optionalKey(Schema.Struct({ source: Schema.String, availability: Schema.String })),
});
export type Artefact = typeof Artefact.Type;
export const ArtefactCollection = Schema.Struct({ items: Schema.Array(Artefact) });
export type ArtefactCollection = typeof ArtefactCollection.Type;

export const RegisterArtefact = Schema.Struct({
  path: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  snapshot: Schema.optional(Schema.Boolean),
  provider: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      namespace: Schema.optional(Schema.String),
      resource: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
    }),
  ),
  metadata: Schema.optional(Schema.Json),
  created: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
});
export type RegisterArtefact = typeof RegisterArtefact.Type;
export const ArtefactRegistered = Schema.Struct({
  address: Schema.Struct({ installation: Schema.String, run: Schema.String, id: Schema.String }),
  item: Artefact,
  retained: Schema.Struct({ revision: Schema.Int, digest: Schema.String, size: Schema.Int }),
});

const dateLine = (date: Artefact["created"]) =>
  date == null ? "unknown" : `${date.at} (${date.provenance})`;
/** What a terminal shows of one artefact, ending with how to open it. */
export const artefactLines = (run: string, item: Artefact): ReadonlyArray<string> => {
  const seen =
    item.seen?.revision === item.revision ? "Seen" : item.seen === null ? "Unseen" : "Updated";
  const held = item.digest === "" ? item.kind : `${item.mediaType} · ${item.size} bytes`;
  const provider = item.provider;
  const hosted =
    provider === undefined
      ? ""
      : ` · ${provider.name} ${Arr.join(
          Arr.filter([provider.namespace, provider.resource], (one) => one !== null),
          "/",
        )} version ${provider.version ?? "unknown"} (${provider.provenance})`;
  const source =
    item.sourceAvailability === "untracked"
      ? "External updates not tracked"
      : `${item.sourceAvailability} source`;
  return [
    `${item.title} · ${item.role} · ${held} · revision ${item.revision} · ${seen}`,
    `Created: ${dateLine(item.created)} · Updated: ${dateLine(item.updated)} · Observed: ${item.observedAt}`,
    `${source} · ${item.retainedAvailability} retained${hosted}`,
    item.url !== undefined
      ? `Open: ${item.url}`
      : `collie run artefact read ${run} ${item.id} --revision ${item.revision}`,
  ];
};

/** Where a page of a host's search ended, in its order: newest detected first, then Run and id. */
export const ArtefactKey = Schema.Struct({
  detectedAt: Schema.String,
  run: Schema.String,
  id: Schema.String,
});
export type ArtefactKey = typeof ArtefactKey.Type;
export const ArtefactSearch = Schema.Struct({
  query: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  unseen: Schema.optional(Schema.Boolean),
  after: Schema.optional(ArtefactKey),
  limit: Schema.optional(Schema.Int),
});
export type ArtefactSearch = typeof ArtefactSearch.Type;
/** One host's page, and how many of its retained Runs its catalogue has reached. */
export const ArtefactMatches = Schema.Struct({
  items: Schema.Array(Artefact),
  more: Schema.Boolean,
  coverage: Schema.Struct({ runs: Schema.Int, indexed: Schema.Int }),
});
export type ArtefactMatches = typeof ArtefactMatches.Type;
