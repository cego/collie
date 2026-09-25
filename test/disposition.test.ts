// The one thing this record must never do is edit history. A Run that failed and whose
// work a human then merged by hand has two facts about it, and the temptation in both
// directions — leave the row red, or tidy the status — loses one of them.
//
// The nonmutation claim is worth nothing asserted over an object the code never saw, so
// it is made against a real Run, through the CLI a person actually types: its status
// before and after, a repeated request id, and a read that reads.

import { Effect, FileSystem, Schema } from "effect";
import { expect, test } from "bun:test";
import {
  dispositionPath,
  latest,
  readDispositions,
  recordDisposition,
  statusLine,
  type Disposition,
} from "../src/disposition";
import { hosted, settledRun } from "./support/hosted";
import { runEffect, watchedBy } from "./support/effect";

const root = new URL("../", import.meta.url).pathname;
const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ code: Schema.String })),
  }),
);
const parseEnvelope = Schema.decodeUnknownEffect(Envelope);

/** The CLI as a person runs it, against a state directory that survives between calls. */
const cli = Effect.fn("test.cli")(function* (args: string[], env: Record<string, string>) {
  const watch = yield* watchedBy;
  const proc = Bun.spawn([Bun.argv[0] ?? "bun", join(root, "src/main.ts"), ...args], {
    cwd: root,
    env: {
      HERDR_PLUGIN_ROOT: root,
      PWD: root,
      COLLIE_HOST_WATCH_PID: watch,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = yield* Effect.promise(() =>
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
  );
  return { stdout, stderr, exit };
});

const line = (over: Partial<Disposition> = {}): Disposition => ({
  at: "2026-09-11T10:00:00.000Z",
  by: "mk",
  kind: "merged",
  ref: "cego/collie!43",
  note: null,
  ...over,
});

test(
  "the CLI records a disposition and leaves the Run's status as it was",
  () =>
    hosted("hw-disposition-", ({ world }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = {
          HERDR_PLUGIN_ROOT: world.install,
          HERDR_PLUGIN_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          HOME: world.home,
        };
        // A Run that failed, which is the case this exists for.
        const run = yield* settledRun(world, "retains");
        const failed = "failed: merge: picker";

        // Reading before anything is recorded reads, and writes nothing.
        const empty = yield* cli(["--json", "run", "disposition", run.id], env);
        expect(empty.exit).toBe(0);
        expect(yield* parseEnvelope(empty.stdout)).toMatchObject({
          ok: true,
          data: { status: failed, disposition: null },
        });
        expect(yield* fs.exists(yield* dispositionPath(run.dir))).toBe(false);

        const record = [
          "--json",
          "run",
          "disposition",
          run.id,
          "--as",
          "merged",
          "--ref",
          "cego/collie!43",
          "--request-id",
          "req-1",
        ];
        const recorded = yield* cli(record, env);
        expect(recorded.exit).toBe(0);
        expect(yield* parseEnvelope(recorded.stdout)).toMatchObject({
          ok: true,
          data: { status: failed, disposition: { kind: "merged", ref: "cego/collie!43" } },
        });
        expect((yield* readDispositions(run.dir)).length).toBe(1);

        // A replayed request id returns the first result rather than recording twice.
        const replay = yield* cli(record, env);
        expect(replay.exit).toBe(0);
        expect(yield* parseEnvelope(replay.stdout)).toMatchObject({ ok: true });
        expect((yield* readDispositions(run.dir)).length).toBe(1);

        // The whole point: how the Run ended is still how it ended.
        expect(
          yield* parseEnvelope((yield* cli(["--json", "run", "disposition", run.id], env)).stdout),
        ).toMatchObject({ ok: true, data: { status: failed } });

        // And `run show` says both facts.
        const shown = yield* cli(["run", "show", run.id], env);
        expect(shown.exit).toBe(0);
        expect(shown.stdout).toContain(`${failed} · merged cego/collie!43`);
      }),
    ),
  // Five CLI spawns of a TypeScript entrypoint; the default 5s is not enough.
  60_000,
);

test("a correction is a new line, so what people believed before is still there", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "hw-disposition-" });

      yield* recordDisposition(dir, line({ kind: "abandoned", ref: "", note: "dropped" }));
      yield* recordDisposition(dir, line({ at: "2026-09-12T08:00:00.000Z", by: "mk" }));

      const lines = yield* readDispositions(dir);
      expect(lines.map((l) => l.kind)).toEqual(["abandoned", "merged"]);
      expect(latest(lines)?.ref).toBe("cego/collie!43");
      // An abandoned Run with nothing to point at still reads without a dangling space.
      expect(statusLine("failed", lines[0]!)).toBe("failed · abandoned by mk");

      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ));

test("a Run nobody recorded a disposition for reads exactly as it always did", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "hw-disposition-" });
      expect(yield* readDispositions(dir)).toEqual([]);
      expect(statusLine("done", latest(yield* readDispositions(dir)))).toBe("done");
      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ));
