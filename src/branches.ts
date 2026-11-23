// What git last said of each checkout and branch a card reads, as rows in the host's database
// (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs). A card reads these rows; only
// the git syncer, on a turn, a Step's end, a publish, a push or the backstop poll, asks git.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Context, Effect, Layer, Option, Result, Schema, flow } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { readFinalCard } from "./cards";
import { projectHere, shell } from "./mr";
import { branchMovement } from "./recovery";

export const Branch = Schema.Struct({
  /** The commit the branch is at in the checkout, or null where git could not say. */
  head: Schema.NullOr(Schema.String),
  /** The project the checkout pushes to, which a bare or legacy reference resolves against. */
  project: Schema.NullOr(Schema.String),
  /** How the pushed branch moved past the finished record it was read against. */
  movement: Schema.NullOr(
    Schema.Struct({ finished: Schema.String, said: Schema.NullOr(Schema.String) }),
  ),
});
export type Branch = typeof Branch.Type;

const BranchJson = Schema.fromJsonString(Branch);
const encodeBranch = flow(Schema.encodeResult(BranchJson), Result.getOrThrow);
const decodeBranch = Schema.decodeUnknownOption(BranchJson);

/** A branch's key in the rows: its checkout and its name. */
export const branchKey = (cwd: string, branch: string | null) => `${cwd}\0${branch ?? ""}`;

/** What the git syncer reads a branch by. */
export interface BranchRun {
  readonly cwd: string;
  readonly dir: string;
  readonly branch: string | null;
  readonly state: string;
}

export interface BranchesApi {
  /** Every row, by `branchKey`. */
  readonly all: Effect.Effect<ReadonlyMap<string, Branch>>;
  /** Writes what moved; a read that moves nothing invalidates nothing. */
  readonly put: (rows: ReadonlyMap<string, Branch>) => Effect.Effect<void>;
  /** Asks the git syncer for a branch a card found no row of. */
  readonly want: (run: BranchRun) => Effect.Effect<void>;
  /** The branches asked for since the last call. */
  readonly wanted: Effect.Effect<ReadonlyArray<BranchRun>>;
}

export class Branches extends Context.Service<Branches, BranchesApi>()("collie/Branches") {}

/** What a moved branch invalidates. */
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
          if (rows.size === 0) return;
          const known = yield* all;
          const moved = Arr.filter([...rows], ([key, row]) => {
            const was = known.get(key);
            return was === undefined || encodeBranch(was) !== encodeBranch(row);
          });
          if (moved.length === 0) return;
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

/** What git says now of `run`'s branch in its checkout: the git syncer's one read. */
export const readBranch = Effect.fn("Branches.read")(function* (run: BranchRun) {
  const project = yield* projectHere(run.cwd, shell);
  if (run.branch === null) return { head: null, project, movement: null } satisfies Branch;
  const read = yield* shell(
    "git",
    ["rev-parse", "--verify", "--quiet", `${run.branch}^{commit}`],
    run.cwd,
  );
  const sha = Str.trim(read.stdout);
  const final = yield* readFinalCard(run.dir).pipe(Effect.orElseSucceed(() => Option.none()));
  const finished = Option.match(final, {
    onNone: () => "",
    onSome: (card) => card.revision.head_sha,
  });
  return {
    head: read.code === 0 && sha !== "" ? sha : null,
    project,
    movement:
      finished === ""
        ? null
        : { finished, said: yield* branchMovement(run).pipe(Effect.orElseSucceed(() => null)) },
  } satisfies Branch;
});
