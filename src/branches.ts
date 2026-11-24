import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Context, Effect, Layer, Option, Result, Schema, flow } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { readFinalCard } from "./cards";
import { projectHere, shell } from "./mr";
import { branchMovement } from "./recovery";

export const Movement = Schema.Struct({
  finished: Schema.String,
  said: Schema.NullOr(Schema.String),
});
export type Movement = typeof Movement.Type;

export const Branch = Schema.Struct({
  head: Schema.NullOr(Schema.String),
  // WARNING: a bare or legacy merge request reference resolves against this project.
  project: Schema.NullOr(Schema.String),
  movements: Schema.Array(Movement),
});
export type Branch = typeof Branch.Type;

const KEPT_MOVEMENTS = 8;

const BranchJson = Schema.fromJsonString(Branch);
const encodeBranch = flow(Schema.encodeResult(BranchJson), Result.getOrThrow);
const decodeBranch = Schema.decodeUnknownOption(BranchJson);

export const branchKey = (cwd: string, branch: string | null) => `${cwd}\0${branch ?? ""}`;

export interface BranchRun {
  readonly cwd: string;
  readonly dir: string;
  readonly branch: string | null;
  readonly state: string;
}

export interface BranchesApi {
  readonly all: Effect.Effect<ReadonlyMap<string, Branch>>;
  // WARNING: a write that moves nothing invalidates nothing.
  readonly put: (rows: ReadonlyMap<string, Branch>) => Effect.Effect<void>;
  readonly want: (run: BranchRun) => Effect.Effect<void>;
  readonly wanted: Effect.Effect<ReadonlyArray<BranchRun>>;
}

export class Branches extends Context.Service<Branches, BranchesApi>()("collie/Branches") {}

export const BRANCHES = "collie/branches";

export const branchesLayer = Layer.effect(Branches)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const all = sql<{ readonly key: string; readonly row: string }>`
      SELECT key, row FROM collie_branches
    `.pipe(
      Effect.map(
        (rows) =>
          new Map(
            Arr.flatMap(rows, (one) =>
              Option.match(decodeBranch(one.row), {
                onNone: () => [],
                onSome: (row) => [[one.key, row] as const],
              }),
            ),
          ),
      ),
      Effect.orDie,
    );
    let asked = new Map<string, BranchRun>();
    return {
      all,
      want: (run) => Effect.sync(() => void asked.set(branchKey(run.cwd, run.branch), run)),
      wanted: Effect.sync(() => {
        const taken = [...asked.values()];
        asked = new Map();
        return taken;
      }),
      put: (rows) =>
        Effect.gen(function* () {
          if (rows.size === 0) {
            return;
          }
          const known = yield* all;
          const moved = Arr.filter([...rows], ([key, row]) => {
            const was = known.get(key);
            return was === undefined || encodeBranch(was) !== encodeBranch(row);
          });
          if (moved.length === 0) {
            return;
          }
          yield* sql
            .withTransaction(
              Effect.forEach(
                moved,
                ([key, row]) => sql`
                  INSERT INTO collie_branches (key, row) VALUES (${key}, ${encodeBranch(row)})
                  ON CONFLICT (key) DO UPDATE SET row = excluded.row
                `,
                { discard: true },
              ),
            )
            .pipe(Effect.orDie);
          yield* reactivity.invalidate([BRANCHES]);
        }),
    } satisfies BranchesApi;
  }),
);

export const readBranch = Effect.fn("Branches.read")(function* (
  runs: ReadonlyArray<BranchRun>,
  kept: ReadonlyArray<Movement> = [],
) {
  const first = Arr.head(runs).pipe(Option.getOrThrow);
  const project = yield* projectHere(first.cwd, shell);
  if (first.branch === null) {
    return { head: null, project, movements: [] } satisfies Branch;
  }
  const read = yield* shell(
    "git",
    ["rev-parse", "--verify", "--quiet", `${first.branch}^{commit}`],
    first.cwd,
  );
  const head = read.code === 0 && Str.trim(read.stdout) !== "" ? Str.trim(read.stdout) : null;
  const fresh = yield* Effect.forEach(runs, (run) =>
    readFinalCard(run.dir).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.flatMap((final) =>
        Option.match(final, {
          onNone: () => Effect.succeed([]),
          onSome: (card) =>
            branchMovement(run).pipe(
              Effect.orElseSucceed(() => null),
              Effect.map((said) => [{ finished: card.revision.head_sha, said }]),
            ),
        }),
      ),
    ),
  );
  const finished = Arr.map(Arr.flatten(fresh), (one) => one.finished);
  return {
    head,
    project,
    movements: [
      ...Arr.flatten(fresh),
      ...Arr.filter(kept, (one) => !Arr.contains(finished, one.finished)),
    ].slice(0, KEPT_MOVEMENTS),
  } satisfies Branch;
});
