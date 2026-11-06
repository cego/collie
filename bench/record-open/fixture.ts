// The state the samples start from: Runs settled under a host on the fake herdr, the oldest
// moved back as if settled long ago, and live Runs still writing.

import { Database } from "bun:sqlite";
import { readdirSync, statSync, utimesSync } from "node:fs";
import { Effect, FileSystem } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { connect } from "../../src/host";
import { stopHost } from "../../test/support/host";
import { root, world } from "./world";

export interface Fixture {
  readonly runs: number;
  readonly large: ReadonlyArray<string>;
  readonly old: ReadonlyArray<string>;
  readonly live: ReadonlyArray<string>;
  readonly settled: ReadonlyArray<string>;
}

export const COUNTS = { runs: 520, large: 5, old: 40, live: 3 };

const startEach = (inputs: ReadonlyArray<{ id: string; input: Record<string, string> }>) =>
  Effect.forEach(
    inputs,
    ({ id, input }) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state);
        const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
        return (yield* client.start({ project: world.project, id, request, input })).runId;
      }).pipe(Effect.scoped),
    { concurrency: 16 },
  );

const OLD_DAYS = 40;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
const earlier = (text: string) =>
  text.replace(ISO, (at) => new Date(Date.parse(at) - OLD_DAYS * 86_400_000).toISOString());

const filesUnder = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );

/** Moves everything these Runs recorded OLD_DAYS back: their files, their times and rows. */
const backdate = (runs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const run of runs)
      for (const dir of [`${world.state}/runs/${run}`, `${world.state}/evidence/${run}`]) {
        if (!(yield* fs.exists(dir))) continue;
        for (const file of filesUnder(dir)) {
          yield* fs.writeFileString(file, earlier(yield* fs.readFileString(file)));
          const at = new Date(statSync(file).mtimeMs - OLD_DAYS * 86_400_000);
          utimesSync(file, at, at);
        }
      }
    const db = new Database(`${world.state}/host.db`);
    for (const table of ["collie_runs", "collie_decisions"]) {
      const columns = db
        .query<{ name: string; type: string }, []>(`pragma table_info(${table})`)
        .all()
        .filter((column) => column.name !== "run" && column.type === "TEXT");
      for (const run of runs)
        for (const { name } of columns)
          for (const row of db
            .query<{ rowid: number; text: string }, [string]>(
              `select rowid, "${name}" as text from ${table} where run = ? and "${name}" is not null`,
            )
            .all(run))
            db.query(`update ${table} set "${name}" = ? where rowid = ?`).run(
              earlier(row.text),
              row.rowid,
            );
    }
    db.close();
  });

export const prepare = (counts = COUNTS) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    Bun.spawnSync(["git", "init", "-q"], { cwd: world.project });
    yield* fs.copyFile(
      `${root}bench/record-open/workflows/bench-steps.workflow.ts`,
      `${world.user}/bench-steps.workflow.ts`,
    );
    const settled = counts.runs - counts.large - counts.live;
    if (settled <= counts.old)
      return yield* Effect.die(
        new Error(
          `--runs ${counts.runs} leaves no recent settled Run beside ${counts.old} old ones`,
        ),
      );
    const small = yield* startEach(
      Array.from({ length: settled }, () => ({
        id: "bench-steps",
        input: { steps: "6", live: "no" },
      })),
    );
    const large = yield* startEach(
      Array.from({ length: counts.large }, () => ({
        id: "bench-steps",
        input: { steps: "220", live: "no" },
      })),
    );
    const lives = yield* startEach(
      Array.from({ length: counts.live }, () => ({
        id: "bench-steps",
        input: { steps: "5", live: "yes" },
      })),
    );
    const client = yield* connect(world.state);
    for (;;) {
      const views = yield* client.runs({ task: null });
      const done = views.filter((view) => view.status.status === "complete").length;
      if (done >= small.length + large.length) break;
      yield* Effect.sleep("1 second");
    }
    yield* stopHost(world.state);
    // An old settled Run is on the board only while it leaves work to file: here, a plan.
    for (const run of small.slice(0, counts.old)) {
      yield* fs.makeDirectory(`${world.state}/runs/${run}/plan/issues`, { recursive: true });
      yield* fs.writeFileString(`${world.state}/runs/${run}/plan/issues/01-bench.md`, "# Bench\n");
    }
    yield* backdate(small.slice(0, counts.old));
    const fixture: Fixture = {
      runs: counts.runs,
      large,
      old: small.slice(0, counts.old),
      live: lives,
      settled: small.slice(counts.old),
    };
    return fixture;
  }).pipe(Effect.scoped);
