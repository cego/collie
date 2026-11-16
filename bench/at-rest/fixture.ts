/* oxlint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-console-in-effect, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-record, effecttsgo/prefer-effect-string, effecttsgo/prefer-schema-over-json, no-restricted-globals, no-restricted-properties -- the benchmark's drivers speak to processes, files and /proc on their own terms, as record-open's do. */
// The pinned base creates the history, so candidate migrations must read what it left.

import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { connect } from "../../src/host";
import { runEffect } from "../../test/support/effect";
import { stopHost } from "../../test/support/host";
import { measuring, refusal, userStateDir } from "../record-open/guards";
import { enterWorld, keptFixture, live, manifestPath, root, socket, userEnv, world } from "./world";

const SLEEP_DAYS = 30;

export interface Manifest {
  readonly settled: ReadonlyArray<string>;
  readonly reported: Readonly<Record<string, string>>;
  readonly owing: ReadonlyArray<string>;
  readonly asking: ReadonlyArray<string>;
  readonly sleeping: ReadonlyArray<string>;
  readonly cluster_messages: number;
  readonly cluster_replies: number;
  readonly wakes: Readonly<Record<string, string>>;
}

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    settled: { type: "string", default: "748" },
    reported: { type: "string", default: "40" },
    owing: { type: "string", default: "6" },
    asking: { type: "string", default: "2" },
    sleeping: { type: "string", default: "4" },
  },
});
const refused = await runEffect(
  refusal({ state: world.state, socket }, { home: homedir(), env: userEnv }),
);
if (refused !== null) {
  console.error(refused);
  process.exit(2);
}
const say = (line: string) => Effect.sync(() => console.error(line));

const startEach = (id: string, count: number, input: Record<string, string>) =>
  Effect.forEach(
    Array.from({ length: count }),
    () =>
      Effect.gen(function* () {
        const client = yield* connect(world.state);
        const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
        return (yield* client.start({ project: world.project, id, request, input })).runId;
      }).pipe(Effect.scoped),
    { concurrency: 16 },
  );

const manifest = await runEffect(
  measuring(
    `${userStateDir(homedir(), userEnv)}/measurements/machine.lock`,
    say,
    Effect.gen(function* () {
      rmSync(live, { recursive: true, force: true });
      yield* enterWorld;
      yield* Effect.addFinalizer(() => stopHost(world.state));
      const git = (argv: string[]) => {
        const result = Bun.spawnSync(["git", ...argv], { cwd: world.project, env: Bun.env });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      };
      git(["init", "-q", "-b", "main"]);
      writeFileSync(`${world.project}/sample.ts`, "export const sample = 1;\n");
      git(["add", "sample.ts"]);
      git([
        "-c",
        "user.name=Benchmark",
        "-c",
        "user.email=bench@localhost",
        "commit",
        "-qm",
        "Fixture",
      ]);
      git(["checkout", "-qb", "bench"]);
      for (const from of [
        "record-open/workflows/bench-steps",
        "at-rest/workflows/bench-wait",
        "at-rest/workflows/bench-report",
        "at-rest/workflows/bench-active",
      ])
        cpSync(
          `${root}bench/${from}.workflow.ts`,
          `${world.user}/${from.split("/").at(-1)}.workflow.ts`,
        );
      yield* say(`building the fixture with the host at ${root}`);
      const settled = yield* startEach("bench-steps", Number(flags.settled), {
        steps: "16",
        live: "no",
      });
      const reported = yield* startEach("bench-report", Number(flags.reported), {
        on: "done",
        steps: "16",
      });
      const owing = yield* startEach("bench-report", Number(flags.owing), {
        on: "ask",
        steps: "16",
      });
      const asking = yield* startEach("bench-wait", Number(flags.asking), {
        on: "ask",
        seconds: "0",
      });
      const sleeping = yield* startEach("bench-wait", Number(flags.sleeping), {
        on: "sleep",
        seconds: String(SLEEP_DAYS * 86_400),
      });
      const client = yield* connect(world.state);
      const waiting = new Set([...owing, ...asking, ...sleeping]);
      for (;;) {
        const views = yield* client.runs({ task: null });
        const done = views.filter((view) => view.status.status === "complete").length;
        const suspended = views.filter(
          (view) => view.status.status === "suspended" && waiting.has(view.runId),
        ).length;
        const reports = new Map(
          views.flatMap((view) =>
            view.report === undefined ? [] : [[view.runId, view.report.at]],
          ),
        );
        if (
          done >= settled.length + reported.length &&
          suspended >= waiting.size &&
          reported.every((run) =>
            views.some((view) => view.runId === run && view.report?.closed === true),
          )
        ) {
          yield* stopHost(world.state);
          const db = new Database(`${world.state}/host.db`, { readonly: true });
          const count = (table: string) =>
            db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()!.n;
          const kept: Manifest = {
            settled,
            reported: Object.fromEntries(reported.map((run) => [run, reports.get(run)!])),
            owing,
            asking,
            sleeping,
            cluster_messages: count("cluster_messages"),
            cluster_replies: count("cluster_replies"),
            wakes: Object.fromEntries(
              views.flatMap((view) =>
                view.wakes === undefined || view.wakes === null ? [] : [[view.runId, view.wakes]],
              ),
            ),
          };
          db.close();
          for (const run of settled.slice(0, 40)) {
            const plan = `${world.state}/runs/${run}/plan`;
            mkdirSync(`${plan}/issues`, { recursive: true });
            writeFileSync(
              `${plan}/SPEC.md`,
              "# Fixture plan\n\nKeep the host responsive with a large history.\n",
            );
            writeFileSync(
              `${plan}/issues/01-work.md`,
              "# Work\n\n- [ ] Preserve every Run's view\n",
            );
          }
          return kept;
        }
        yield* Effect.sleep("15 seconds");
      }
    }).pipe(Effect.timeout("25 minutes"), Effect.scoped, Effect.orDie),
  ),
);
rmSync(keptFixture, { recursive: true, force: true });
cpSync(live, keptFixture, { recursive: true });
rmSync(live, { recursive: true, force: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
console.error(
  `kept ${manifest.settled.length + Object.keys(manifest.reported).length + manifest.owing.length + manifest.asking.length + manifest.sleeping.length} Runs, ${manifest.cluster_messages} cluster messages, in ${keptFixture}`,
);
