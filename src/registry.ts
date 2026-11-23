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

// WARNING: an agent name names a role, not a process; the incarnation identifies the process.
export interface Incarnation {
  terminalId: string;
  agentSession: { kind: string; value: string } | null;
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
  incarnation?: Incarnation;
}
export interface RegistryScope {
  session: string | null;
  workspaceId: string | null;
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
  // WARNING: optional so an older register still decodes; such an entry can be stopped and pruned, never delivered to.
  incarnation: Schema.optionalKey(IncarnationSchema),
});
const EntryJson = Schema.fromJsonString(AgentEntrySchema);
export const encodeAgentEntry = flow(Schema.encodeResult(EntryJson), Result.getOrThrow);
const decodeEntry = Schema.decodeOption(EntryJson);
export const decodeRegisterOption = Schema.decodeOption(
  Schema.fromJsonString(Schema.Array(AgentEntrySchema)),
);

export function registerOf(scope: RegistryScope) {
  const where = scope.workspaceId ?? scope.cwd;
  const last = Option.getOrElse(
    Arr.last(Arr.filter(pipe_(where, Str.split("/")), (part) => part !== "")),
    () => "",
  );
  return `${pipe_(last, Str.replace(/[^A-Za-z0-9._-]+/g, "-")) || "repo"}-${scopeKey(scope)}`;
}

// WARNING: exported so steering shares this key; two copies of the formula would disagree about which workspace is which.
export function scopeKey(scope: RegistryScope) {
  const where = scope.workspaceId ?? scope.cwd;
  return pipe_(Bun.hash(`${scope.session ?? ""} ${where}`).toString(16), Str.slice(0, 12));
}

export function scopeFor(cwd: string) {
  return { session: null, workspaceId: null, cwd };
}

export const REGISTERED = "collie/registered";

export interface RegisteredApi {
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
    const returned: RegisteredApi = {
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
    };
    return returned;
  }),
);

export const everyRegistered = Registered.use((registered) => registered.all);

// WARNING: an entry registered before core's listing, whose agent core lacks, is dropped.
export const registerAgent = (
  scope: RegistryScope,
  entry: AgentEntry,
  alive?: { readonly agents: ReadonlyArray<AgentInfo>; readonly listedAt: string },
) => Registered.use((registered) => registered.register(scope, entry, alive));

// WARNING: fails closed: an entry without an incarnation is never delivered to.
export function deliverable(entry: AgentEntry): entry is AgentEntry & { incarnation: Incarnation } {
  return entry.incarnation !== undefined;
}

// WARNING: a name match is not enough: core's own incarnation must match too.
export function verifyIncarnation(entry: AgentEntry, alive: ReadonlyArray<AgentInfo>) {
  if (!deliverable(entry)) {
    const returned: { ok: true; info: AgentInfo } | { ok: false; reason: string } = {
      ok: false,
      reason: "no_incarnation",
    };
    return returned;
  }
  if (entry.incarnation.backend !== "core") {
    const returned: { ok: true; info: AgentInfo } | { ok: false; reason: string } = {
      ok: false,
      reason: "agent_gone",
    };
    return returned;
  }
  const [live] = matching(entry, alive);
  if (!live) {
    const returned: { ok: true; info: AgentInfo } | { ok: false; reason: string } = {
      ok: false,
      reason: "agent_gone",
    };
    return returned;
  }
  if (live.terminalId !== entry.incarnation.terminalId) {
    const returned: { ok: true; info: AgentInfo } | { ok: false; reason: string } = {
      ok: false,
      reason: "incarnation_changed",
    };
    return returned;
  }
  const returned: { ok: true; info: AgentInfo } | { ok: false; reason: string } = {
    ok: true,
    info: live,
  };
  return returned;
}

function matching(entry: AgentEntry, alive: ReadonlyArray<AgentInfo>) {
  return Arr.filter(alive, (a) => a.name === entry.agent && a.paneId === entry.paneId);
}

export function liveEntries(entries: ReadonlyArray<AgentEntry>, alive: ReadonlyArray<AgentInfo>) {
  return Arr.filter(entries, (e) => matching(e, alive).length > 0);
}

// WARNING: another Run's agent in the role is never the answer; this is read only.
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
