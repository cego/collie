import { Schema, Effect, FileSystem, Path } from "effect";
import type { AgentInfo } from "./herdr";

/**
 * herdr's own identity for one live agent process, recorded when it is registered and
 * checked again every time something is about to be sent to it. An agent name is reused
 * by whatever takes that role next and a pane outlives what ran in it, so neither names
 * a process; `terminal_id` does. Nothing here is invented — no pid, no start time.
 */
export interface Incarnation {
  terminalId: string;
  /** The harness session herdr says it is driving, where it knows one. */
  agentSession: { kind: string; value: string } | null;
}

export interface AgentEntry {
  role: string;
  agent: string;
  paneId: string;
  workspaceId: string | null;
  runId: string;
  workflow: string;
  at: string;
  /** Absent on an entry written before incarnations: never a delivery target. */
  incarnation?: Incarnation;
}
export interface RegistryScope {
  session: string | null;
  workspaceId: string | null;
  /** Names the register only where there is no workspace to name it by. */
  cwd: string;
}

export const IncarnationSchema = Schema.Struct({
  terminalId: Schema.String,
  agentSession: Schema.NullOr(Schema.Struct({ kind: Schema.String, value: Schema.String })),
});

const AgentEntrySchema = Schema.Struct({
  role: Schema.String,
  agent: Schema.String,
  paneId: Schema.String,
  workspaceId: Schema.NullOr(Schema.String),
  runId: Schema.String,
  workflow: Schema.String,
  at: Schema.String,
  // Optional so a register written before incarnations still decodes. It reads as an
  // entry that can be stopped and pruned but never delivered to, which is what it is.
  incarnation: Schema.optionalKey(IncarnationSchema),
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
  const where = scope.workspaceId ?? scope.cwd;
  const name = path.basename(where).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
  return path.join(stateDir, "agents", `${name}-${scopeKey(scope)}.json`);
});

/**
 * The short stable key a Session's per-workspace state is filed under. The workspace is
 * the Session, so a Run's own worktree and the board's directory read the same one; the
 * directory only stands in where there is no workspace. Exported because the register is
 * no longer the only thing keyed this way — steering defaults are too — and two copies of
 * the formula is two answers to "which workspace is this".
 */
export function scopeKey(scope: RegistryScope): string {
  const where = scope.workspaceId ?? scope.cwd;
  return Bun.hash(`${scope.session ?? ""} ${where}`)
    .toString(16)
    .slice(0, 12);
}

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

/** Every agent registered in this state directory, whichever Session registered it. */
export const everyRegistered = Effect.fn("everyRegistered")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(stateDir, "agents");
  const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])));
  const entries: AgentEntry[] = [];
  for (const name of names.filter((one) => one.endsWith(".json")))
    entries.push(...(yield* readRegistry(path.join(dir, name))));
  return entries;
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

/**
 * Whether anything may be sent to this entry at all. A register is a cache of what herdr
 * was last seen to have, and an entry with no incarnation names a role and a pane, both
 * of which the next agent inherits — so a delivery to it could reach a process nobody
 * addressed. Fail closed: the entry stays stoppable and prunable, and undeliverable.
 */
export function deliverable(entry: AgentEntry): entry is AgentEntry & { incarnation: Incarnation } {
  return entry.incarnation !== undefined;
}

/**
 * Whether this entry still names the process it was registered for. `liveEntries`
 * answers "is an agent by this name on this pane", which the next incarnation in the
 * same role also satisfies; this additionally requires herdr's own identity to match.
 * The reason is returned rather than logged here, so the caller records it where its
 * own refusal is recorded.
 */
export function verifyIncarnation(
  entry: AgentEntry,
  alive: ReadonlyArray<AgentInfo>,
): { ok: true; info: AgentInfo } | { ok: false; reason: string } {
  if (!deliverable(entry)) return { ok: false, reason: "no_incarnation" };
  const [live] = matching(entry, alive);
  if (!live) return { ok: false, reason: "agent_gone" };
  if (live.terminalId !== entry.incarnation.terminalId)
    return { ok: false, reason: "incarnation_changed" };
  const session = entry.incarnation.agentSession;
  if (
    session !== null &&
    (live.agentSession === null ||
      live.agentSession.kind !== session.kind ||
      live.agentSession.value !== session.value)
  )
    return { ok: false, reason: "incarnation_changed" };
  return { ok: true, info: live };
}

function matching(entry: AgentEntry, alive: ReadonlyArray<AgentInfo>): AgentInfo[] {
  return alive.filter(
    (a) =>
      a.name === entry.agent &&
      a.paneId === entry.paneId &&
      (a.workspaceId === null || entry.workspaceId === null || a.workspaceId === entry.workspaceId),
  );
}

export function liveEntries(
  entries: ReadonlyArray<AgentEntry>,
  alive: ReadonlyArray<AgentInfo>,
): AgentEntry[] {
  return entries.filter((e) => matching(e, alive).length > 0);
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
