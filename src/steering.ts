import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema, flow, Result } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { markWorked } from "./run-records";
import { readJournal, type Journal } from "./journal";
import { ensureLockDir, withLock } from "./lock";
import { StoreWrites } from "./store-writes";
import { nowIso, epochMs } from "./time";
import { coreSocket } from "./hc";
import { FrontDoor } from "./board-model";

const CauseSchema = Schema.Struct({
  kind: Schema.Literals([
    "step",
    "repair",
    "nudge",
    "handoff",
    "compaction",
    "steer",
    "correction",
    "followup",
  ]),
  ref: Schema.String,
});
export type Cause = Schema.Schema.Type<typeof CauseSchema>;
const DELIVERY_STATES = [
  "reserved",
  "deferred",
  "submitted",
  "acknowledged",
  "failed",
  "unknown",
  "superseded",
] as const;

export const SENT_STATES: ReadonlySet<string> = new Set(["submitted", "acknowledged"]);

export const toldLine = (agent: string, text: string) =>
  `${agent}: told "${Str.split(text, "\n")[0] ?? ""}"`;

export function toldIn(log: string, agent: string) {
  const prefix = `${agent}: told "`;
  const line = Option.getOrUndefined(
    Arr.findLast(
      Str.split(log, "\n"),
      (one) => pipe_(one, Str.startsWith(prefix)) && pipe_(one, Str.endsWith('"')),
    ),
  );
  const returned: string | null =
    line === undefined ? null : pipe_(line, Str.slice(prefix.length, -1));
  return returned;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(["failed", "superseded"]);

const HumanDoorSchema = Schema.Struct({
  origin: FrontDoor,
  conversation: Schema.optionalKey(Schema.String),
});
export type HumanDoor = typeof HumanDoorSchema.Type;

export const DeliverySchema = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  run: Schema.String,
  incarnation: Schema.String,
  agent: Schema.String,
  causal_key: Schema.String,
  request_id: Schema.String,
  cause: CauseSchema,
  mode: Schema.Literals(["boundary", "now", "interrupt"]),
  text_hash: Schema.String,
  intent_version: Schema.Int,
  attempt: Schema.Int,
  state: Schema.Literals(DELIVERY_STATES),
  evidence: Schema.optionalKey(Schema.Struct({ kind: Schema.String, ref: Schema.String })),
  code: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  workflowNotice: Schema.optionalKey(Schema.String),
  human: Schema.optionalKey(HumanDoorSchema),
});
export type Delivery = Schema.Schema.Type<typeof DeliverySchema>;

const OverrideSchema = Schema.Struct({
  kind: Schema.Literals(["manual_override", "override_cleared"]),
  at: Schema.String,
  incarnation: Schema.String,
  by: Schema.String,
  note: Schema.optionalKey(Schema.String),
  conversation: Schema.optionalKey(Schema.String),
  said: Schema.optionalKey(Schema.String),
});
export type Override = Schema.Schema.Type<typeof OverrideSchema>;

export type LedgerLine = Delivery | Override;
const LedgerLineSchema = Schema.Union([OverrideSchema, DeliverySchema]);
const LedgerLineJson = Schema.fromJsonString(LedgerLineSchema);

function isDelivery(line: LedgerLine): line is Delivery {
  return "state" in line;
}

function digest(value: string) {
  return Bun.hash(value).toString(16);
}

export function textHash(text: string) {
  return digest(text);
}

export function causalKey(run: string, cause: Cause, intentVersion: number) {
  return digest(`${run}\u0000${cause.kind}\u0000${cause.ref}\u0000${intentVersion}`);
}

export const LEDGER_FILE = "deliveries.jsonl";

export function incarnationKey(terminalId: string) {
  return digest(terminalId);
}

type HumanSubmit = Delivery & { readonly human: HumanDoor };

export interface DeliveriesApi {
  readonly append: (line: LedgerLine) => Effect.Effect<void>;
  readonly ledger: (incarnation: string) => Effect.Effect<Journal<LedgerLine>>;
  readonly ofRun: (run: string) => Effect.Effect<ReadonlyArray<Delivery>>;
  readonly newestOf: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
  readonly about: (
    incarnation: string,
    causalKey: string,
  ) => Effect.Effect<ReadonlyArray<Delivery>>;
  readonly humanSubmits: Effect.Effect<ReadonlyArray<HumanSubmit>>;
  readonly overridden: Effect.Effect<ReadonlySet<string>>;
  readonly forget: (runs: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class Deliveries extends Context.Service<Deliveries, DeliveriesApi>()("collie/Deliveries") {}

export const DELIVERIES = "collie/deliveries";

const encodeLedgerLine = flow(Schema.encodeResult(LedgerLineJson), Result.getOrThrow);
const decodeLedgerLine = Schema.decodeUnknownOption(LedgerLineJson);
const deliveriesIn = (rows: ReadonlyArray<{ readonly line: string }>) =>
  Arr.filter(
    Arr.flatMap(rows, (row) => Option.toArray(decodeLedgerLine(row.line))),
    isDelivery,
  );

export const deliveriesLayer = Layer.effect(Deliveries)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const told = Option.getOrUndefined(yield* Effect.serviceOption(StoreWrites));
    const newest = (run: string) => sql<{ readonly line: string }>`
      SELECT line FROM collie_deliveries
      JOIN (
        SELECT MIN(seq) AS first, MAX(seq) AS last FROM collie_deliveries
        WHERE run = ${run} AND id IS NOT NULL GROUP BY ledger, id
      ) ON seq = last
      ORDER BY first
    `;
    const returned: DeliveriesApi = {
      append: (line) =>
        Effect.gen(function* () {
          const ledger = incarnationKey(line.incarnation);
          yield* sql`INSERT INTO collie_deliveries (ledger, line) VALUES (${ledger}, ${encodeLedgerLine(line)})`;
          if (isDelivery(line))
            yield* markWorked(line.run).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          const runs = isDelivery(line)
            ? [line.run]
            : Arr.map(
                yield* sql<{ readonly run: string }>`
                  SELECT DISTINCT run FROM collie_deliveries WHERE ledger = ${ledger} AND run IS NOT NULL
                `,
                (row) => row.run,
              );
          told?.(runs);
          yield* reactivity.invalidate([DELIVERIES]);
        }).pipe(Effect.orDie),
      ledger: (incarnation) =>
        sql<{ readonly line: string }>`
          SELECT line FROM collie_deliveries WHERE ledger = ${incarnationKey(incarnation)} ORDER BY seq
        `.pipe(
          Effect.map((rows) => {
            const lines: LedgerLine[] = [];
            let corrupt = 0;
            for (const row of rows) {
              const line = decodeLedgerLine(row.line);
              if (Option.isSome(line)) lines.push(line.value);
              else corrupt += 1;
            }
            return { lines, corrupt };
          }),
          Effect.orDie,
        ),
      ofRun: (run) => newest(run).pipe(Effect.map(deliveriesIn), Effect.orDie),
      newestOf: (runs) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<{ readonly run: string; readonly line: string }>`
              SELECT newest.run, line FROM collie_deliveries
              JOIN (
                SELECT run, MIN(seq) AS first, MAX(seq) AS last FROM collie_deliveries
                WHERE run IN ${sql.in(runs)} AND id IS NOT NULL GROUP BY run, ledger, id
              ) AS newest ON seq = newest.last
              ORDER BY newest.run, newest.first
            `.pipe(
              Effect.map((rows) => {
                const byRun = new Map<string, string[]>();
                for (const row of rows)
                  byRun.set(row.run, [...(byRun.get(row.run) ?? []), row.line]);
                return byRun;
              }),
              Effect.orDie,
            ),
      about: (incarnation, causalKey) =>
        sql<{ readonly line: string }>`
          SELECT line FROM collie_deliveries
          JOIN (
            SELECT MIN(seq) AS first, MAX(seq) AS last FROM collie_deliveries
            WHERE ledger = ${incarnationKey(incarnation)} AND causal_key = ${causalKey} GROUP BY id
          ) ON seq = last
          ORDER BY first
        `.pipe(Effect.map(deliveriesIn), Effect.orDie),
      humanSubmits: sql<{ readonly line: string }>`
        SELECT line FROM collie_deliveries WHERE seq IN (
          SELECT MIN(seq) FROM collie_deliveries
          WHERE human = 1 AND state IN ('submitted', 'acknowledged') GROUP BY id
        ) ORDER BY seq
      `.pipe(
        Effect.map((rows) =>
          Arr.flatMap(deliveriesIn(rows), (one) =>
            one.human === undefined ? [] : [{ ...one, human: one.human }],
          ),
        ),
        Effect.orDie,
      ),
      overridden: sql<{ readonly run: string }>`
        SELECT DISTINCT run FROM collie_deliveries WHERE run IS NOT NULL AND ledger IN (
          SELECT ledger FROM collie_deliveries WHERE kind = 'manual_override' AND seq IN (
            SELECT MAX(seq) FROM collie_deliveries WHERE kind IS NOT NULL GROUP BY ledger
          )
        )
      `.pipe(
        Effect.map((rows) => new Set(Arr.map(rows, (row) => row.run))),
        Effect.orDie,
      ),
      forget: (runs) =>
        Effect.gen(function* () {
          if (runs.length === 0) return;
          yield* sql`
            DELETE FROM collie_deliveries WHERE ledger IN (
              SELECT ledger FROM collie_deliveries WHERE run IS NOT NULL GROUP BY ledger
              HAVING SUM(run NOT IN ${sql.in(runs)}) = 0
            )
          `;
          yield* reactivity.invalidate([DELIVERIES]);
        }).pipe(Effect.orDie),
    };
    return returned;
  }),
);

export const appendLine = (line: LedgerLine) => Deliveries.use((ledgers) => ledgers.append(line));

export const readLedger = (incarnation: string) =>
  Effect.map(readLedgerWhole(incarnation), (ledger) => ledger.lines);

export const readLedgerWhole = (incarnation: string) =>
  Deliveries.use((ledgers) => ledgers.ledger(incarnation));

export function newestById(lines: ReadonlyArray<LedgerLine>) {
  const newest = new Map<string, Delivery>();
  for (const line of lines) if (isDelivery(line)) newest.set(line.id, line);
  const returned: Map<string, Delivery> = newest;
  return returned;
}

export const deliveriesAhead = Effect.fn("Steering.deliveriesAhead")(function* (
  deliveries: DeliveriesApi,
  runs: ReadonlyArray<string>,
) {
  const ids = new Set(runs);
  const all = yield* Effect.cached(deliveries.newestOf(runs));
  const returned: DeliveriesApi = {
    ...deliveries,
    ofRun: (run) =>
      ids.has(run)
        ? Effect.map(all, (got) => deliveriesIn(Arr.map(got.get(run) ?? [], (line) => ({ line }))))
        : deliveries.ofRun(run),
  };
  return returned;
});

export const deliveriesOf = Effect.fn("Steering.deliveriesOf")(function* (run: string) {
  return yield* Deliveries.use((ledgers) => ledgers.ofRun(run));
});

export const deliveriesAbout = (incarnation: string, causalKey: string) =>
  Deliveries.use((ledgers) => ledgers.about(incarnation, causalKey));

export const humanSubmits = Deliveries.use((ledgers) => ledgers.humanSubmits);

export const forgetDeliveries = (runs: ReadonlyArray<string>) =>
  Deliveries.use((ledgers) => ledgers.forget(runs));

export const overriddenRuns = Deliveries.use((ledgers) => ledgers.overridden);

export function blocked(lines: ReadonlyArray<LedgerLine>, causal_key: string, resending?: string) {
  let found: Delivery | null = null;
  for (const delivery of newestById(lines).values()) {
    if (delivery.causal_key !== causal_key) continue;
    if (TERMINAL_STATES.has(delivery.state)) continue;
    if (delivery.id === resending && delivery.state === "deferred") continue;
    if (found === null || delivery.at > found.at) found = delivery;
  }
  const returned: Delivery | null = found;
  return returned;
}

export function deferralsOf(lines: ReadonlyArray<LedgerLine>, id: string) {
  let since: string | null = null;
  let count = 0;
  for (const line of lines) {
    if (!isDelivery(line) || line.id !== id || line.state === "reserved") continue;
    if (line.state !== "deferred") {
      since = null;
      count = 0;
      continue;
    }
    since ??= line.at;
    count += 1;
  }
  return { since, count };
}

export function settleStaleReservations(
  lines: ReadonlyArray<LedgerLine>,
  nowMs: number,
  submitTimeoutMs: number,
  at: string,
) {
  const settled: Delivery[] = [];
  for (const delivery of newestById(lines).values()) {
    if (delivery.state !== "reserved") continue;
    const reservedAt = epochMs(delivery.at);
    if (Number.isNaN(reservedAt) || nowMs - reservedAt < submitTimeoutMs) continue;
    settled.push({
      ...delivery,
      at,
      state: "unknown",
      note: "reserved and never settled (crash or lost result)",
    });
  }
  const returned: Delivery[] = settled;
  return returned;
}

export function overrideActive(lines: ReadonlyArray<LedgerLine>) {
  let active = false;
  for (const line of lines) {
    if (isDelivery(line)) continue;
    active = line.kind === "manual_override";
  }
  return active;
}

export const isUnobserved = (delivery: Delivery) =>
  delivery.state === "submitted" &&
  Option.getOrUndefined(
    Option.map(Option.fromNullishOr(delivery.note), (present) =>
      pipe_(present, Str.startsWith("unobserved")),
    ),
  ) === true;

export const isSettledDelivery = (delivery: Delivery) =>
  delivery.state !== "reserved" &&
  delivery.state !== "deferred" &&
  delivery.state !== "unknown" &&
  !isUnobserved(delivery);

export function reconcile(
  lines: ReadonlyArray<LedgerLine>,
  id: string,
  as: "sent" | "not-sent",
  by: string,
  at: string,
) {
  const delivery = newestById(lines).get(id);
  if (!delivery) {
    const returned: Delivery | { readonly error: string } = {
      error: `no delivery "${id}" in this ledger`,
    };
    return returned;
  }
  if (delivery.state !== "unknown" && !isUnobserved(delivery)) {
    const returned: Delivery | { readonly error: string } = {
      error: `delivery "${id}" is ${delivery.state}`,
    };
    return returned;
  }
  const returned: Delivery | { readonly error: string } = {
    ...delivery,
    at,
    state: "superseded",
    note: `reconciled as ${as} by ${by}`,
  };
  return returned;
}

export class HerdrUnreachable extends Data.TaggedError("HerdrUnreachable")<{ why: string }> {}

export const herdKey = Effect.fn("Steering.herdKey")(function* <R>(
  socketPath: string | null,
  fromStatus: () => Effect.Effect<string | null, never, R>,
) {
  const socket = socketPath ?? (yield* fromStatus());
  if (socket === null || socket === "")
    return yield* new HerdrUnreachable({
      why: "no socket path",
    });
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(socket).pipe(Effect.orElseSucceed(() => socket));
  return digest(real);
});

export const herdOf = (socketPath: string | null) =>
  herdKey(socketPath, () => Effect.succeed(null));

export const machineHerd = (env: { readonly raw: Readonly<Record<string, string | undefined>> }) =>
  Effect.flatMap(coreSocket(env.raw), herdOf);

export const herdDir = Effect.fn("Steering.herdDir")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, "herd", key);
});

const BudgetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("reserve"),
    id: Schema.String,
    run: Schema.NullOr(Schema.String),
    at: Schema.String,
    max_usd: Schema.optionalKey(Schema.Finite),
    max_seconds: Schema.Finite,
    max_output_bytes: Schema.Finite,
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("settle"),
    id: Schema.String,
    at: Schema.String,
    outcome: Schema.Literals(["ok", "failed", "timeout", "over_output", "killed"]),
    usd: Schema.optionalKey(Schema.Finite),
    seconds: Schema.Finite,
    bytes: Schema.Finite,
  }),
]);
export type BudgetLine = Schema.Schema.Type<typeof BudgetSchema>;
const BudgetJson = Schema.fromJsonString(BudgetSchema);
const encodeBudget = flow(Schema.encodeResult(BudgetJson), Result.getOrThrow);

export const budgetPath = Effect.fn("Steering.budgetPath")(function* (
  stateDir: string,
  key: string,
) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "budget.jsonl");
});

export const readBudget = (file: string) => readJournal(file, BudgetJson);

export interface CallLimits {
  readonly maxSeconds: number;
  readonly maxOutputBytes: number;
  readonly model?: string;
  readonly effort?: string;
}

function staleSettlements(lines: ReadonlyArray<BudgetLine>, nowMs: number, at: string) {
  const settled = new Set(Arr.flatMap(lines, (l) => (l.kind === "settle" ? [l.id] : [])));
  const answer: BudgetLine[] = Arr.flatMap(lines, (line) => {
    if (line.kind !== "reserve" || settled.has(line.id)) {
      const returned: BudgetLine[] = [];
      return returned;
    }
    const startedAt = epochMs(line.at);
    if (Number.isNaN(startedAt) || nowMs - startedAt < 2 * line.max_seconds * 1000) {
      const returned: BudgetLine[] = [];
      return returned;
    }
    {
      const returned: BudgetLine[] = [
        { kind: "settle", id: line.id, at, outcome: "failed", seconds: 0, bytes: 0 },
      ];
      return returned;
    }
  });
  return answer;
}

export function planReservation(
  lines: ReadonlyArray<BudgetLine>,
  request: { readonly id: string; readonly run: string | null; readonly at: string },
  limits: CallLimits,
) {
  const nowMs = epochMs(request.at);
  const stale = staleSettlements(lines, nowMs, request.at);
  const reserve: BudgetLine = {
    kind: "reserve",
    id: request.id,
    run: request.run,
    at: request.at,
    max_seconds: limits.maxSeconds,
    max_output_bytes: limits.maxOutputBytes,
  };
  const asked =
    limits.model === undefined || limits.effort === undefined
      ? reserve
      : { ...reserve, model: limits.model, effort: limits.effort };
  return { append: [...stale, asked] };
}

export const appendBudget = Effect.fn("Steering.appendBudget")(function* (
  file: string,
  lines: ReadonlyArray<BudgetLine>,
) {
  if (lines.length === 0) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const body = Arr.join(
    Arr.map(lines, (line) => encodeBudget(line)),
    "\n",
  );
  yield* fs.writeFileString(file, `${body}\n`, { flag: "a" });
});

export const reserve = Effect.fn("Steering.reserve")(function* (
  file: string,
  request: { readonly id: string; readonly run: string | null },
  limits: CallLimits,
) {
  const at = yield* nowIso;
  yield* ensureLockDir(file);
  const write = Effect.gen(function* () {
    const planned = planReservation(yield* readBudget(file), { ...request, at }, limits);
    yield* appendBudget(file, planned.append);
  });
  yield* withLock(`${file}.lock`, write, write);
  return request.id;
});

export const settle = Effect.fn("Steering.settle")(function* (
  file: string,
  id: string,
  actual: {
    readonly outcome: "ok" | "failed" | "timeout" | "over_output" | "killed";
    readonly usd?: number | undefined;
    readonly seconds: number;
    readonly bytes: number;
  },
) {
  const at = yield* nowIso;
  const line: Extract<BudgetLine, { kind: "settle" }> = {
    kind: "settle",
    id,
    at,
    outcome: actual.outcome,
    seconds: actual.seconds,
    bytes: actual.bytes,
  };
  yield* appendBudget(file, [actual.usd === undefined ? line : { ...line, usd: actual.usd }]);
});
