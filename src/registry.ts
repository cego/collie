import { Schema, Effect, FileSystem, Path } from "effect";
import type { AgentInfo } from "./herdr";

export interface AgentEntry {
  role: string;
  agent: string;
  paneId: string;
  workspaceId: string | null;
  runId: string;
  workflow: string;
  at: string;
}
export interface RegistryScope {
  session: string | null;
  workspaceId: string | null;
  /** Names the register only where there is no workspace to name it by. */
  cwd: string;
}

const AgentEntrySchema = Schema.Struct({
  role: Schema.String,
  agent: Schema.String,
  paneId: Schema.String,
  workspaceId: Schema.NullOr(Schema.String),
  runId: Schema.String,
  workflow: Schema.String,
  at: Schema.String,
});
const RegistryJson = Schema.fromJsonString(Schema.Array(AgentEntrySchema));
const encodeRegistry = Schema.encodeSync(RegistryJson);
const decodeRegistry = Schema.decodeUnknownEffect(RegistryJson);

/**
 * `Bun.hash` and not an Effect equivalent: Effect has no non-cryptographic digest, and
 * this only needs a short stable key for a filename. `Crypto` offers randomness and
 * cryptographic hashing, neither of which is what a scope key is.
 */
export const registryPath = Effect.fn("registryPath")(function* (
  stateDir: string,
  scope: RegistryScope,
) {
  const path = yield* Path.Path;
  // The workspace is the Session, so a Run's own worktree and the board's directory
  // read the same register; the directory only stands in where there is no workspace.
  const where = scope.workspaceId ?? scope.cwd;
  const key = Bun.hash(`${scope.session ?? ""} ${where}`)
    .toString(16)
    .slice(0, 12);
  const name = path.basename(where).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
  return path.join(stateDir, "agents", `${name}-${key}.json`);
});

export function scopeFor(
  env: { socketPath: string | null; workspaceId: string | null },
  cwd: string,
): RegistryScope {
  return { session: env.socketPath, workspaceId: env.workspaceId, cwd };
}

/**
 * The register a Run's own agents are on, which is not the register of whoever is
 * asking about them. A Driver is spawned with the Run's session, its workspace and its
 * checkout (`operations.spawnDriver`), so those three are what it registered under —
 * and a board of every workspace stops and hands off runs that were never this
 * Session's.
 */
export function scopeOfRun(record: {
  session: string | null;
  workspace: string | null;
  cwd: string;
}): RegistryScope {
  return { session: record.session, workspaceId: record.workspace, cwd: record.cwd };
}

/**
 * The Session's live agents, or none. A register half-written or edited by hand is a
 * cache of what herdr was last seen to have, not a source of truth, so it is read as
 * empty rather than failing a stop, a hand-off or the Control Plane. The decode runs
 * in the error channel, not as a throw inside `Effect.map`: a `SchemaError` raised
 * there was a defect, and the fallback on the next line never ran.
 */
export const readRegistry = Effect.fn("readRegistry")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return [];
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeRegistry),
    Effect.catch(() => Effect.succeed([])),
  );
});

const write = Effect.fn("writeRegistry")(function* (
  file: string,
  entries: ReadonlyArray<AgentEntry>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${encodeRegistry(entries)}\n`);
});

export const registerAgent = Effect.fn("registerAgent")(function* (
  file: string,
  entry: AgentEntry,
) {
  const kept = (yield* readRegistry(file)).filter(
    (e) => e.role !== entry.role && e.agent !== entry.agent,
  );
  const entries = [...kept, entry];
  yield* write(file, entries);
  return entries;
});

export function liveEntries(
  entries: ReadonlyArray<AgentEntry>,
  alive: ReadonlyArray<AgentInfo>,
): AgentEntry[] {
  return entries.filter((e) =>
    alive.some(
      (a) =>
        a.name === e.agent &&
        a.paneId === e.paneId &&
        (a.workspaceId === null || e.workspaceId === null || a.workspaceId === e.workspaceId),
    ),
  );
}

export const pruneRegistry = Effect.fn("pruneRegistry")(function* (
  file: string,
  alive: ReadonlyArray<AgentInfo>,
) {
  const entries = yield* readRegistry(file);
  const live = liveEntries(entries, alive);
  if (live.length !== entries.length) yield* write(file, live);
  return live;
});

export const liveAgent = Effect.fn("liveAgent")(function* (
  file: string,
  alive: AgentInfo[],
  role: string,
) {
  return (yield* pruneRegistry(file, alive)).find((e) => e.role === role) ?? null;
});
