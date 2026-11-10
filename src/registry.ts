import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Context, Layer, Schema, Effect, flow, Result } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { AgentInfo } from "./herdr";
import { StoreWrites } from "./store-writes";
import { epochMs } from "./time";

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
  /** Absent for an agent in herdr. */
  backend?: "core";
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
  backend: Schema.optionalKey(Schema.Literal("core")),
});

export const AgentEntrySchema = Schema.Struct({
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
const EntryJson = Schema.fromJsonString(AgentEntrySchema);
export const encodeAgentEntry = flow(Schema.encodeResult(EntryJson), Result.getOrThrow);
const decodeEntry = Schema.decodeOption(EntryJson);
/** A register file as an older build wrote it, for the import. */
export const decodeRegisterOption = Schema.decodeOption(
  Schema.fromJsonString(Schema.Array(AgentEntrySchema)),
);

/** The register a scope's agents are kept in, named as its file was so the import keeps it. */
export function registerOf(scope: RegistryScope): string {
  const where = scope.workspaceId ?? scope.cwd;
  const last = Option.getOrElse(
    Arr.last(Arr.filter(pipe_(where, Str.split("/")), (part) => part !== "")),
    () => "",
  );
  return `${pipe_(last, Str.replace(/[^A-Za-z0-9._-]+/g, "-")) || "repo"}-${scopeKey(scope)}`;
}

/**
 * The short stable key a Session's per-workspace state is filed under. The workspace is
 * the Session, so a Run's own worktree and the board's directory read the same one; the
 * directory only stands in where there is no workspace. Exported because the register is
 * no longer the only thing keyed this way — steering defaults are too — and two copies of
 * the formula is two answers to "which workspace is this".
 */
// `Bun.hash`: Effect has no non-cryptographic digest, and this only needs a short stable key.
export function scopeKey(scope: RegistryScope): string {
  const where = scope.workspaceId ?? scope.cwd;
  return pipe_(Bun.hash(`${scope.session ?? ""} ${where}`).toString(16), Str.slice(0, 12));
}

export function scopeFor(
  env: { socketPath: string | null; workspaceId: string | null },
  cwd: string,
): RegistryScope {
  return { session: env.socketPath, workspaceId: env.workspaceId, cwd };
}

/** What a write to the register invalidates. */
export const REGISTERED = "collie/registered";

/** The register, in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database). */
export interface RegisteredApi {
  /** Oldest registration first. */
  readonly all: Effect.Effect<ReadonlyArray<AgentEntry>>;
  readonly register: (
    scope: RegistryScope,
    entry: AgentEntry,
    alive?: { readonly agents: ReadonlyArray<AgentInfo>; readonly listedAt: string },
  ) => Effect.Effect<ReadonlyArray<AgentEntry>>;
}

export class Registered extends Context.Service<Registered, RegisteredApi>()("collie/Registered") {}

const decoded = (rows: ReadonlyArray<{ readonly record: string }>) =>
  Arr.flatMap(rows, (row) => Option.toArray(decodeEntry(row.record)));

export const registeredLayer = Layer.effect(Registered)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const told = Option.getOrUndefined(yield* Effect.serviceOption(StoreWrites));
    const inRegister = (register: string) =>
      sql<{ readonly record: string }>`
        SELECT record FROM collie_agents WHERE register = ${register} ORDER BY rowid
      `.pipe(Effect.map(decoded));
    return {
      all: sql<{ readonly record: string }>`SELECT record FROM collie_agents ORDER BY rowid`.pipe(
        Effect.map(decoded),
        Effect.orDie,
      ),
      register: (scope, entry, alive) => {
        const register = registerOf(scope);
        return Effect.gen(function* () {
          const others = Arr.filter(yield* inRegister(register), (e) => e.agent !== entry.agent);
          const live = new Set(alive === undefined ? others : liveEntries(others, alive.agents));
          const dropped =
            alive === undefined
              ? []
              : Arr.filter(others, (e) => !live.has(e) && epochMs(e.at) < epochMs(alive.listedAt));
          if (dropped.length > 0)
            yield* sql`
              DELETE FROM collie_agents
              WHERE register = ${register} AND agent IN ${sql.in(Arr.map(dropped, (e) => e.agent))}
            `;
          yield* sql`
            INSERT OR REPLACE INTO collie_agents (register, agent, record)
            VALUES (${register}, ${entry.agent}, ${encodeAgentEntry(entry)})
          `;
          told?.([entry.runId, ...Arr.map(dropped, (e) => e.runId)]);
          return yield* inRegister(register);
        }).pipe(
          sql.withTransaction,
          Effect.tap(() => reactivity.invalidate([REGISTERED])),
          Effect.orDie,
        );
      },
    } satisfies RegisteredApi;
  }),
);

/** Every agent registered in this state directory, whichever Session registered it. */
export const everyRegistered = Registered.use((registered) => registered.all);

/**
 * One entry per agent: every Run started from the same place shares a register, and a
 * panel's seats share a Run and a role. Given what herdr listed, an entry registered
 * before that listing whose agent it did not have is dropped; one registered since may be
 * an agent that started after it, as another seat launched at once does.
 */
export const registerAgent = (
  scope: RegistryScope,
  entry: AgentEntry,
  alive?: { readonly agents: ReadonlyArray<AgentInfo>; readonly listedAt: string },
) => Registered.use((registered) => registered.register(scope, entry, alive));

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
  return Arr.filter(
    alive,
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
  return Arr.filter(entries, (e) => matching(e, alive).length > 0);
}

/**
 * The live agent in this role nearest the first of these Runs: that Run's own, then the
 * Run it came from, and so on. Another Run's agent in the role is never the answer. Only
 * read: `alive` may predate an agent registered since, and other Herds share the register.
 */
export const lineageAgent = Effect.fn("lineageAgent")(function* (
  alive: ReadonlyArray<AgentInfo>,
  role: string,
  lineage: ReadonlyArray<string>,
) {
  const live = liveEntries(yield* everyRegistered, alive);
  for (const runId of lineage) {
    const found = Option.getOrUndefined(
      Arr.findLast(live, (e) => e.role === role && e.runId === runId),
    );
    if (found !== undefined) return found;
  }
  return null;
});
