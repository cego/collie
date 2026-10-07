import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { signalProcess } from "../src/lock";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { MARKER, sweepDeadRoots } from "./support/sweep";

const preload = `${import.meta.dir}/support/hosts.ts`;

const Recorded = Schema.Struct({
  pid: Schema.optional(Schema.Number),
  dir: Schema.optional(Schema.String),
});

const alive = (pid: number | undefined) => signalProcess(pid ?? 0, 0);

/** Runs one fixture file under the preload, in a temporary directory of its own. */
const suite = (fixture: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "preload-" });
    const base = `${dir}/tmp`;
    const out = `${dir}/out.json`;
    yield* fs.makeDirectory(base);
    yield* fs.writeFileString(`${dir}/bunfig.toml`, `[test]\npreload = ["${preload}"]\n`);
    yield* fs.writeFileString(`${dir}/fixture.test.ts`, fixture);
    const ran = yield* exec(["bun", "test", "./fixture.test.ts"], {
      cwd: dir,
      env: { ...process.env, TMPDIR: base, FIXTURE_OUT: out },
    });
    const recorded = (yield* fs.exists(out))
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Recorded))(
          yield* fs.readFileString(out),
        )
      : {};
    return { output: ran.stdout + ran.stderr, left: yield* fs.readDirectory(base), recorded };
  }).pipe(Effect.scoped, Effect.orDie);

const header = `
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const record = (what) => writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(what));
`;

describe("the test preload", () => {
  test(
    "a test that leaves a directory fails naming it, and the directory is removed",
    () =>
      runEffect(
        Effect.gen(function* () {
          const run = yield* suite(`${header}
test("leaks", () => { mkdtempSync(join(tmpdir(), "leaked-")); });
test("after", () => { expect(readdirSync(tmpdir()).filter((n) => n.startsWith("leaked-"))).toEqual([]); });
`);
          expect(run.output).toContain("(fail) leaks");
          expect(run.output).toMatch(/directory \S*leaked-/);
          expect(run.output).toContain("1 pass");
          expect(run.left).toEqual([]);
        }),
      ),
    30_000,
  );

  test(
    "a process a test leaves running fails the file, naming it, and is killed",
    () =>
      runEffect(
        Effect.gen(function* () {
          const run = yield* suite(`${header}
test("spawns", () => { record({ pid: Bun.spawn(["sleep", "61"]).pid }); });
`);
          expect(run.output).toContain("1 pass");
          expect(run.output).toMatch(/process pid \d+ \(sleep 61\)/);
          expect(run.output).toContain("1 fail");
          expect(run.recorded.pid).toBeGreaterThan(0);
          expect(yield* alive(run.recorded.pid)).toBe(false);
          expect(run.left).toEqual([]);
        }),
      ),
    30_000,
  );

  test(
    "a test that times out leaves neither its directory nor its process",
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const run = yield* suite(`${header}
test("hangs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "held-"));
  record({ dir, pid: Bun.spawn(["sleep", "62"]).pid });
  await Bun.sleep(10_000);
}, 500);
`);
          expect(run.output).toContain("timed out");
          expect(run.recorded.dir).toBeDefined();
          expect(yield* fs.exists(run.recorded.dir ?? "")).toBe(false);
          expect(yield* alive(run.recorded.pid)).toBe(false);
          expect(run.left).toEqual([]);
        }),
      ),
    30_000,
  );
});

describe("the start-of-suite sweep", () => {
  test("removes a dead suite's root and its processes, and leaves a live one's", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sweep-" });
        const gone = Bun.spawn(["true"]);
        yield* Effect.promise(() => gone.exited);
        const dead = `${dir}/collie-test-${gone.pid}-x`;
        const live = `collie-test-${process.pid}-x`;
        yield* fs.makeDirectory(dead);
        yield* fs.makeDirectory(`${dir}/${live}`);
        // Read-only inside, as a Go module cache is: it still goes.
        yield* fs.makeDirectory(`${dead}/cache/pkg`, { recursive: true });
        yield* fs.chmod(`${dead}/cache`, 0o555);
        const orphan = Bun.spawn(["sh", "-c", "echo up; exec sleep 63"], {
          env: { ...process.env, [MARKER]: dead },
          stdout: "pipe",
        });
        yield* Effect.addFinalizer(() => signalProcess(orphan.pid, "SIGKILL"));
        // Its environment is in /proc once it has started.
        yield* Effect.promise(() => orphan.stdout.getReader().read());

        expect(sweepDeadRoots(dir)).toEqual([dead]);
        expect(yield* fs.readDirectory(dir)).toEqual([live]);
        yield* Effect.promise(() => orphan.exited);
        expect(orphan.signalCode).toBe("SIGKILL");
      }).pipe(Effect.scoped),
    ));
});
