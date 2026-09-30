import { Data, Schema, Effect, FileSystem, Path } from "effect";
import type { AgentInfo } from "./herdr";
import { ensureLockDir, withLock } from "./lock";

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

const registryFiles = Effect.fn("registryFiles")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(stateDir, "agents");
  const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])));
  return names.filter((one) => one.endsWith(".json")).map((name) => path.join(dir, name));
});

/** Every agent registered in this state directory, whichever Session registered it. */
export const everyRegistered = Effect.fn("everyRegistered")(function* (stateDir: string) {
  const entries: AgentEntry[] = [];
  for (const file of yield* registryFiles(stateDir)) entries.push(...(yield* readRegistry(file)));
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

/**
 * One entry per agent: every Run started from the same place shares this file, and a
 * panel's seats share a Run and a role. Given what herdr listed, an entry registered
 * before that listing whose agent it did not have is dropped; one registered since may be
 * an agent that started after it, as another seat launched at once does.
 */
export const registerAgent = Effect.fn("registerAgent")(function* (
  file: string,
  entry: AgentEntry,
  alive?: { readonly agents: ReadonlyArray<AgentInfo>; readonly listedAt: string },
) {
  yield* ensureLockDir(file);
  // Every Run started from the same place writes this file: unlocked, one write loses another's.
  return yield* withLock(
    `${file}.lock`,
    Effect.fail(new RegistryBusy({ file })),
    Effect.gen(function* () {
      const others = (yield* readRegistry(file)).filter((e) => e.agent !== entry.agent);
      const live = new Set(alive === undefined ? others : liveEntries(others, alive.agents));
      const kept =
        alive === undefined
          ? others
          : others.filter((e) => live.has(e) || Date.parse(e.at) >= Date.parse(alive.listedAt));
      const entries = [...kept, entry];
      yield* write(file, entries);
      return entries;
    }),
    REGISTER_CLAIMS,
  );
});

/** Ten seconds of claims: a registration holds the lock only for one read and one write. */
const REGISTER_CLAIMS = 400;

export class RegistryBusy extends Data.TaggedError("RegistryBusy")<{ file: string }> {}

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

/**
 * The live agent in this role nearest the first of these Runs: that Run's own, then the
 * Run it came from, and so on. Another Run's agent in the role is never the answer. Only
 * read: `alive` may predate an agent registered since, and other Herds share these files.
 */
export const lineageAgent = Effect.fn("lineageAgent")(function* (
  stateDir: string,
  alive: ReadonlyArray<AgentInfo>,
  role: string,
  lineage: ReadonlyArray<string>,
) {
  const live: AgentEntry[] = [];
  for (const file of yield* registryFiles(stateDir))
    live.push(...liveEntries(yield* readRegistry(file), alive));
  for (const runId of lineage) {
    const found = live.findLast((e) => e.role === role && e.runId === runId);
    if (found !== undefined) return found;
  }
  return null;
});
