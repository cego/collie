// Where a workflow module lives, and which of them a run gets.
//
// An author saves a file and new work uses it: no registration list to edit, no rebuild,
// no restart. The three places a module may be saved and the order they are read in are
// this module, and so is what is said about one that cannot be read.
//
// Only entry files take part. A helper or a Markdown prompt beside one is reached because
// the entry imports it, never because it was found here.
//
// `docs/adr/0016-a-workflow-module-is-found-where-it-was-saved.md` is why each of these
// is the way it is.

import { Effect, FileSystem, Schema } from "effect";
import { loadEntry, revisionOf } from "./native";

export const ENTRY_SUFFIX = ".workflow.ts";

export const LAYERS = ["project", "user", "shipped"] as const;
export type EntryLayer = (typeof LAYERS)[number];

export interface Root {
  readonly layer: EntryLayer;
  readonly dir: string;
}

/**
 * The three directories, nearest first: what this project says, then what this machine's
 * author has written, then what Collie ships. The author's own is beside the installation
 * rather than inside its shipped assets, because those are a git checkout an upgrade
 * fast-forwards and a file in it would be somebody else's to move.
 */
export const searchPath = (where: {
  readonly pluginRoot: string;
  readonly project: string;
}): ReadonlyArray<Root> => [
  { layer: "project", dir: `${where.project}/.herdr/workflows` },
  { layer: "user", dir: `${where.pluginRoot}/user/workflows` },
  { layer: "shipped", dir: `${where.pluginRoot}/workflows` },
];

/** An entry a caller may run, said as a consumer needs it: what, where, and from which layer. */
export const Resolved = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  layer: Schema.Literals(LAYERS),
  path: Schema.String,
});

/** An id nothing can be run under, and the file that is why. */
export const Fault = Schema.Struct({
  id: Schema.String,
  layer: Schema.Literals(LAYERS),
  path: Schema.String,
  message: Schema.String,
});
export type Fault = typeof Fault.Type;

/** Everything the search path holds, as a client may see it. */
export const Catalogue = Schema.Struct({
  entries: Schema.Array(Resolved),
  problems: Schema.Array(Fault),
});

/** A resolved entry and the revision of the directory a generation of it is staged from. */
export type Found = typeof Resolved.Type & { readonly revision: string };

export interface Catalogued {
  readonly entries: ReadonlyArray<Found>;
  readonly problems: ReadonlyArray<Fault>;
}

/**
 * Every id the search path offers, and every id it refuses. A layer that claims an id
 * settles it: the one below is not consulted, whether the claim loaded or not. An
 * override that does not compile is a file to fix, and running the module it was written
 * to replace would be a silent answer to a question the author did not ask.
 */
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
    return { entries: entries.sort((one, other) => one.id.localeCompare(other.id)), problems };
  },
);

/** What one file in one layer says it is, or why it could not say. */
type Claim =
  | { readonly kind: "entry"; readonly id: string; readonly path: string; readonly found: Found }
  | {
      readonly kind: "fault";
      readonly id: string;
      readonly path: string;
      readonly message: string;
    };

/**
 * Every entry file in a layer, read. A file that cannot be imported claims the id its name
 * says it is: an author who saved `review.workflow.ts` is overriding `review`, and a typo
 * inside it does not turn that into a request for somebody else's `review`.
 */
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
              layer: root.layer,
              path,
              revision,
            },
          },
    );
  }
  return claims;
});

const byId = (claims: ReadonlyArray<Claim>): ReadonlyMap<string, ReadonlyArray<Claim>> => {
  const grouped = new Map<string, Array<Claim>>();
  for (const claim of claims) grouped.set(claim.id, [...(grouped.get(claim.id) ?? []), claim]);
  return grouped;
};

/** Two files, one id: each is told about the other rather than one of them being picked. */
const ambiguous = (
  id: string,
  layer: EntryLayer,
  claimants: ReadonlyArray<Claim>,
): ReadonlyArray<Fault> =>
  claimants.map((claim) => ({
    id,
    layer,
    path: claim.path,
    message: `"${id}" is also claimed by ${claimants
      .filter((other) => other !== claim)
      .map((other) => other.path)
      .join(" and ")}`,
  }));

const entryFiles = Effect.fn("Discovery.entryFiles")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): Array<string> => []));
  return names
    .filter((name) => name.endsWith(ENTRY_SUFFIX))
    .sort()
    .map((name) => `${dir}/${name}`);
});

const stem = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1, path.length - ENTRY_SUFFIX.length);
