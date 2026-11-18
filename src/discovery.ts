import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, FileSystem, Schema } from "effect";
import { loadEntry, revisionOf } from "./engine";
import { jsonSchemaFor, type WorkflowEntry } from "./sdk";
import { Declared, Fault, LAYERS, type EntryLayer } from "./definitions-model";

export { Declared, Fault, LAYERS, type EntryLayer } from "./definitions-model";

export const ENTRY_SUFFIX = ".workflow.ts";

export interface Root {
  readonly layer: EntryLayer;
  readonly dir: string;
}

export const searchPath: (where: {
  readonly pluginRoot: string;
  readonly userDir: string;
  readonly project: string;
}) => ReadonlyArray<Root> = (where) => [
  { layer: "project", dir: `${where.project}/.collie/workflows` },
  { layer: "user", dir: `${where.userDir}/workflows` },
  { layer: "shipped", dir: `${where.pluginRoot}/workflows` },
];

export const savedModules = (where: {
  readonly pluginRoot: string;
  readonly userDir: string;
  readonly cwd: string;
}) =>
  discover(
    searchPath({ pluginRoot: where.pluginRoot, userDir: where.userDir, project: where.cwd }),
  );

export const Resolved = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  layer: Schema.Literals(LAYERS),
  path: Schema.String,
  inputs: Schema.Array(Declared),
  outcome: Schema.NullOr(Schema.String),
  heals: Schema.optionalKey(Schema.Literal(true)),
});

export const Catalogue = Schema.Struct({
  entries: Schema.Array(Resolved),
  problems: Schema.Array(Fault),
});

export type Found = typeof Resolved.Type & {
  readonly revision: string;
  readonly follows?: string;
};

export interface Catalogued {
  readonly entries: ReadonlyArray<Found>;
  readonly problems: ReadonlyArray<Fault>;
}

export const discover: (
  roots: ReadonlyArray<Root>,
) => Effect.Effect<Catalogued, never, FileSystem.FileSystem> = Effect.fn("Discovery.discover")(
  function* (roots: ReadonlyArray<Root>) {
    const entries: Array<Found> = [];
    const problems: Array<Fault> = [];
    const settled = new Set<string>();
    for (const root of roots) {
      const claims = yield* claimsIn(root);
      for (const [id, claimants] of byId(claims)) {
        if (settled.has(id)) continue;
        settled.add(id);
        const only = claimants.length === 1 ? claimants[0] : undefined;
        if (only === undefined) problems.push(...ambiguous(id, root.layer, claimants));
        else if (only.kind === "entry") entries.push(only.found);
        else problems.push({ id, layer: root.layer, path: only.path, message: only.message });
      }
    }
    return {
      entries: entries.sort((one, other) => pipe_(one.id, Str.localeCompare(other.id))),
      problems,
    };
  },
);

type Claim =
  | { readonly kind: "entry"; readonly id: string; readonly path: string; readonly found: Found }
  | {
      readonly kind: "fault";
      readonly id: string;
      readonly path: string;
      readonly message: string;
    };

const claimsIn = Effect.fn("Discovery.claimsIn")(function* (root: Root) {
  const revision = yield* revisionOf(root.dir);
  const claims: Array<Claim> = [];
  for (const path of yield* entryFiles(root.dir)) {
    const read = yield* loadEntry(path, revision).pipe(Effect.result);
    claims.push(
      read._tag === "Failure"
        ? { kind: "fault", id: stem(path), path, message: read.failure.message }
        : {
            kind: "entry",
            id: read.success.id,
            path,
            found: {
              id: read.success.id,
              title: read.success.title,
              description: read.success.description,
              layer: root.layer,
              path,
              inputs: declaredBy(read.success),
              outcome: read.success.metadata?.outcome?.fixed ?? null,
              ...(read.success.metadata?.heals === true && { heals: true as const }),
              ...(read.success.metadata?.follows !== undefined && {
                follows: read.success.metadata.follows,
              }),
              revision,
            },
          },
    );
  }
  return claims;
});

export const declaredBy = (entry: WorkflowEntry) =>
  Arr.map(Rec.toEntries(entry.input), ([name, field]) => {
    const drawn = jsonSchemaFor(field);
    return {
      name,
      required: field.ast.context?.isOptional !== true,
      strategy: entry.metadata?.hints?.[name] ?? null,
      schema: drawn.document,
      limits: drawn.limits,
    };
  });

const byId = (claims: ReadonlyArray<Claim>) => {
  const grouped = new Map<string, Array<Claim>>();
  for (const claim of claims) grouped.set(claim.id, [...(grouped.get(claim.id) ?? []), claim]);
  return grouped;
};

const ambiguous = (id: string, layer: EntryLayer, claimants: ReadonlyArray<Claim>) =>
  Arr.map(claimants, (claim) => ({
    id,
    layer,
    path: claim.path,
    message: `"${id}" is also claimed by ${Arr.join(
      Arr.map(
        Arr.filter(claimants, (other) => other !== claim),
        (other) => other.path,
      ),
      " and ",
    )}`,
  }));

const entryFiles = Effect.fn("Discovery.entryFiles")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  return Arr.map(
    Arr.filter(names, (name) => pipe_(name, Str.endsWith(ENTRY_SUFFIX))).sort(),
    (name) => `${dir}/${name}`,
  );
});

export const stem = (path: string) =>
  pipe_(
    path,
    Str.slice(
      Option.getOrElse(pipe_(path, Str.lastIndexOf("/")), () => -1) + 1,
      path.length - ENTRY_SUFFIX.length,
    ),
  );
