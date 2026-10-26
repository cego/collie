// One budget of test processes per user per Machine
// (ADR-draft-test-processes-share-one-budget-per-machine). A whole suite and a small run each
// take workers from it, in the order they arrived, so the Machine is never oversubscribed and
// a small run never waits behind a whole suite.

// FileSystem cannot write to or close a pipe it did not open.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { closeSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { Clock, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { ensureLockDir, holderLives, processStartTime, withLock } from "../src/lock";
import { described, elapsed } from "./suite-lock";

export interface Budget {
  readonly total: number;
  readonly reserve: number;
}

export type Kind = "whole" | "small";

/** A ticket while it waits, and a hold once admitted. */
export interface Entry {
  readonly id: string;
  readonly kind: Kind;
  readonly state: "waiting" | "held";
  readonly asked: number;
  readonly workers: number;
  readonly seq: number;
}

export type Admission =
  | { readonly _tag: "admit"; readonly workers: number; readonly fewer: string | null }
  | { readonly _tag: "wait"; readonly behind: ReadonlyArray<Entry> };

export const budgetOf = (cores: number, override?: string): Budget => {
  const given = Number(override);
  const total =
    Number.isInteger(given) && given > 0 ? given : Math.max(2, Math.floor((2 * cores) / 3));
  return { total, reserve: Math.max(2, Math.floor(total / 4)) };
};

/** Under two slots for whole suites, both kinds take from all of the budget. */
const pooled = (budget: Budget) => budget.total - budget.reserve < 2;

export const shareOf = (budget: Budget, kind: Kind) =>
  pooled(budget) ? budget.total : kind === "whole" ? budget.total - budget.reserve : budget.reserve;

export const admission = (
  budget: Budget,
  entries: ReadonlyArray<Entry>,
  request: Entry,
): Admission => {
  const share = shareOf(budget, request.kind);
  const classOf = entries.filter(
    (one) => one.id !== request.id && (pooled(budget) || one.kind === request.kind),
  );
  const earlier = classOf.filter((one) => one.state === "waiting" && one.seq < request.seq);
  if (earlier.length > 0)
    return { _tag: "wait", behind: earlier.toSorted((a, b) => a.seq - b.seq) };
  const holds = classOf.filter((one) => one.state === "held");
  const workers = Math.min(request.asked, share);
  if (holds.reduce((sum, one) => sum + one.workers, 0) + workers > share)
    return { _tag: "wait", behind: holds };
  const of = pooled(budget)
    ? `runs share all ${share}`
    : request.kind === "whole"
      ? `a whole suite has at most ${share}`
      : `small runs share ${share}`;
  return {
    _tag: "admit",
    workers,
    fewer:
      workers < request.asked
        ? `asked for ${request.asked} workers and got ${workers}: ${of} of a budget of ${budget.total}`
        : null,
  };
};

const ProcessSchema = Schema.Struct({ pid: Schema.Int, start: Schema.NullOr(Schema.String) });
const StoredSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["whole", "small"]),
  state: Schema.Literals(["waiting", "held"]),
  asked: Schema.Int,
  workers: Schema.Int,
  seq: Schema.Int,
  processes: Schema.Array(ProcessSchema),
});
const StateSchema = Schema.Struct({ next: Schema.Int, entries: Schema.Array(StoredSchema) });
const StateJson = Schema.fromJsonString(StateSchema);
const decodeState = Schema.decodeUnknownOption(StateJson);
const encodeState = Schema.encodeSync(StateJson);

export type Process = typeof ProcessSchema.Type;
export type Stored = typeof StoredSchema.Type;
type State = typeof StateSchema.Type;

/** The environment variable that tells a `bun test` it runs on a hold, and which. */
export const HOLD_ENV = "COLLIE_TEST_HOLD";

/** Per user, so one user's runs never wait on a store they cannot clean. */
export const STORE = `${tmpdir()}/collie-test-budget-${process.getuid?.() ?? "user"}`;

const POLL = "250 millis";

export const ownProcess = Effect.gen(function* () {
  const pid = process.pid;
  return { pid, start: yield* processStartTime(pid) };
});

export const processOf = (pid: number) =>
  Effect.map(processStartTime(pid), (start): Process => ({ pid, start }));

const alive = (one: Stored) =>
  Effect.map(Effect.forEach(one.processes, holderLives), (each) => each.includes(true));

/** Reads the store, drops what no live process holds, and writes back what `change` makes of it. */
const modify = <A>(dir: string, change: (state: State) => readonly [State, A]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${dir}/budget.json`;
    yield* ensureLockDir(file);
    return yield* withLock(
      `${dir}/budget.lock`,
      Effect.die(new Error(`${dir}/budget.lock could not be taken`)),
      Effect.gen(function* () {
        const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
        const read = Option.getOrElse(decodeState(raw), (): State => ({ next: 0, entries: [] }));
        const entries = yield* Effect.filter(read.entries, alive);
        const [next, result] = change({ ...read, entries });
        const tmp = `${file}.${process.pid}.tmp`;
        yield* fs.writeFileString(tmp, encodeState(next));
        yield* fs.rename(tmp, file);
        return result;
      }),
      Duration.seconds(10),
    );
  }).pipe(Effect.orDie);

/** What the store holds now, after dropping what no live process holds. */
export const entriesOf = (dir: string) => modify(dir, (state) => [state, state.entries] as const);

export const enqueue = (
  dir: string,
  kind: Kind,
  asked: number,
  processes: ReadonlyArray<Process>,
) =>
  modify(dir, (state) => {
    const ticket: Stored = {
      id: `${processes[0]?.pid ?? 0}-${state.next}`,
      kind,
      state: "waiting",
      asked,
      workers: 0,
      seq: state.next,
      processes,
    };
    return [{ next: state.next + 1, entries: [...state.entries, ticket] }, ticket] as const;
  });

type Looked =
  | Extract<Admission, { _tag: "admit" }>
  | { readonly _tag: "wait"; readonly behind: ReadonlyArray<Stored> };

/** One look: admits the ticket when it may go, and otherwise says whom it waits behind. */
export const look = (dir: string, budget: Budget, id: string) =>
  modify(dir, (state): readonly [State, Looked] => {
    const mine = state.entries.find((one) => one.id === id);
    if (mine === undefined) throw new Error(`ticket ${id} is not in the budget's store`);
    const decided = admission(budget, state.entries, mine);
    if (decided._tag === "wait") {
      const behind = decided.behind.map((one) => state.entries.find((it) => it.id === one.id)!);
      return [state, { _tag: "wait", behind }];
    }
    const entries = state.entries.map((one) =>
      one.id === id ? { ...one, state: "held" as const, workers: decided.workers } : one,
    );
    return [{ ...state, entries }, decided];
  });

export const leave = (dir: string, id: string) =>
  modify(
    dir,
    (state) =>
      [{ ...state, entries: state.entries.filter((one) => one.id !== id) }, undefined] as const,
  );

/** Names another process that runs on the hold, such as the `bun test` its runner starts. */
export const join = (dir: string, id: string, joined: Process) =>
  modify(
    dir,
    (state) =>
      [
        {
          ...state,
          entries: state.entries.map((one) =>
            one.id === id ? { ...one, processes: [...one.processes, joined] } : one,
          ),
        },
        undefined,
      ] as const,
  );

const behindLine = (one: Stored) =>
  Effect.gen(function* () {
    const what = one.kind === "whole" ? "suite" : "run";
    const pid = one.processes[0]?.pid ?? 0;
    const ps = yield* described(pid);
    const who = ps === null ? `process ${pid}` : `process ${pid} (${ps.command})`;
    return one.state === "held"
      ? `test: waiting for the ${what} in ${who}${ps === null ? "" : `, running since ${ps.start}`}`
      : `test: waiting behind the ${what} in ${who}, which queued first`;
  });

/**
 * Holds `asked` workers of `kind` from the budget for as long as the scope lasts, waiting in
 * turn for them. A wait says whom it is behind once, then every `every` how long it has been.
 */
export const admitted = (
  dir: string,
  budget: Budget,
  kind: Kind,
  asked: number,
  say: (line: string) => Effect.Effect<void>,
  every: Duration.Input = "30 seconds",
) =>
  Effect.gen(function* () {
    const ticket = yield* Effect.acquireRelease(
      Effect.flatMap(ownProcess, (me) => enqueue(dir, kind, asked, [me])),
      (one) => leave(dir, one.id),
    );
    const began = yield* Clock.currentTimeMillis;
    let told = began;
    for (let first = true; ; first = false) {
      const decided = yield* look(dir, budget, ticket.id);
      if (decided._tag === "admit")
        return {
          id: ticket.id,
          workers: decided.workers,
          fewer: decided.fewer,
          waited: (yield* Clock.currentTimeMillis) - began,
        };
      const now = yield* Clock.currentTimeMillis;
      if (first) yield* say(yield* behindLine(decided.behind[0]!));
      else if (now - told >= Duration.toMillis(Duration.fromInputUnsafe(every))) {
        told = now;
        yield* say(`test: still waiting, ${elapsed(now - began)} so far`);
      }
      yield* Effect.sleep(POLL);
    }
  });

/**
 * Starts `cmd` on the hold, named in it so it counts as long as it runs, and stops it if the
 * scope ends first. `cmd` runs only once it is named: a runner that dies first closes the
 * gate it waits on, and it exits instead.
 */
export const startOnHold = (
  dir: string,
  id: string,
  cmd: ReadonlyArray<string>,
  options: { readonly env: Record<string, string | undefined>; readonly inherit?: boolean },
) =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn(["sh", "-c", 'read -r go <&3 && exec "$@" 3<&-', "sh", ...cmd], {
          env: { ...options.env, [HOLD_ENV]: id },
          stdio: options.inherit
            ? ["inherit", "inherit", "inherit", "pipe"]
            : ["ignore", "ignore", "ignore", "pipe"],
        }),
      ),
      (child) =>
        Effect.gen(function* () {
          child.kill();
          const ended = yield* Effect.promise(() => child.exited).pipe(
            Effect.timeoutOption("2 seconds"),
          );
          if (Option.isNone(ended)) {
            child.kill("SIGKILL");
            yield* Effect.promise(() => child.exited);
          }
        }),
    );
    const gate = child.stdio[3]!;
    yield* Effect.flatMap(processOf(child.pid), (named) => join(dir, id, named)).pipe(
      Effect.andThen(Effect.sync(() => writeSync(gate, "go\n"))),
      Effect.ensuring(Effect.sync(() => closeSync(gate))),
    );
    return child;
  });
