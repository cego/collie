import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { signalProcess } from "../src/lock";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import {
  MARKER,
  MEMORY_FREE_BYTES,
  marked,
  rootBase,
  sweepDeadRoots,
  sweepEveryBase,
} from "./support/sweep";

const preload = `${import.meta.dir}/support/hosts.ts`;

const Recorded = Schema.Struct({
  pid: Schema.optional(Schema.Finite),
  dir: Schema.optional(Schema.String),
  runs: Schema.optional(
    Schema.Array(Schema.Struct({ pid: Schema.Finite, root: Schema.String, home: Schema.String })),
  ),
});

const alive = (pid: number | undefined) => signalProcess(pid ?? 0, 0);

/** Runs one fixture file under the preload, in a temporary directory of its own. */
const suite = (fixture: string, args: ReadonlyArray<string> = [], memory = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "preload-" });
    const base = memory ? `${dir}/memory` : `${dir}/tmp`;
    const out = `${dir}/out.json`;
    yield* fs.makeDirectory(`${dir}/tmp`);
    if (memory) yield* fs.makeDirectory(base);
    yield* fs.writeFileString(`${dir}/bunfig.toml`, `[test]\npreload = ["${preload}"]\n`);
    yield* fs.writeFileString(`${dir}/fixture.test.ts`, fixture);
    const ran = yield* exec(["bun", "test", ...args, "./fixture.test.ts"], {
      cwd: dir,
      env: {
        ...process.env,
        TMPDIR: `${dir}/tmp`,
        COLLIE_TEST_MEMORY: memory ? base : `${dir}/no-memory`,
        FIXTURE_OUT: out,
      },
    });
    const recorded = (yield* fs.exists(out))
      ? yield* Schema.decodeEffect(Schema.fromJsonString(Recorded))(yield* fs.readFileString(out))
      : {};
    return {
      output: ran.stdout + ran.stderr,
      base,
      left: yield* fs.readDirectory(base),
      recorded,
    };
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

describe("the test preload under --rerun-each", () => {
  test(
    "every run gets a root of its own, and none is left",
    () =>
      runEffect(
        Effect.gen(function* () {
          const run = yield* suite(
            `${header}
const runs = (globalThis.runs ??= []);
test("sees its root", () => {
  runs.push({ pid: process.pid, root: tmpdir(), home: process.env.HOME });
  expect(process.env.${MARKER}).toBe(tmpdir());
  expect(readdirSync(tmpdir())).toEqual(["home"]);
  record({ runs });
});
`,
            ["--rerun-each", "3"],
          );
          expect(run.output).toContain("3 pass");
          expect(run.output).toContain("0 fail");
          const runs = run.recorded.runs ?? [];
          expect(runs).toHaveLength(3);
          for (const one of runs) {
            expect(pipe_(one.root, Str.startsWith(`${run.base}/collie-test-${one.pid}-`))).toBe(
              true,
            );
            expect(pipe_(one.home, Str.startsWith(`${one.root}/`))).toBe(true);
            expect(marked(one.root)).toEqual([]);
          }
          expect(new Set(Arr.map(runs, (one) => one.root)).size).toBe(3);
          expect(
            Arr.filter(run.left, (name) => pipe_(name, Str.startsWith("collie-test-"))),
          ).toEqual([]);
        }),
      ),
    30_000,
  );

  test(
    "a directory left on the second run fails that run, naming it, and is removed",
    () =>
      runEffect(
        Effect.gen(function* () {
          const run = yield* suite(
            `${header}
globalThis.runs = (globalThis.runs ?? 0) + 1;
test("leaks on the second run", () => {
  if (globalThis.runs === 2) mkdtempSync(join(tmpdir(), "leaked-"));
});
`,
            ["--rerun-each", "3"],
          );
          expect(run.output).toContain("2 pass");
          expect(run.output).toContain("1 fail");
          expect(run.output).toMatch(/directory \S*leaked-/);
          expect(run.left).toEqual([]);
        }),
      ),
    30_000,
  );
});

describe("where a test file's root is made", () => {
  test("on the memory filesystem while it has room", () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* suite(
          `${header}
test("sees its root", () => record({ dir: tmpdir() }));
`,
          [],
          true,
        );
        expect(run.output).toContain("1 pass");
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(run.recorded.dir), (present) =>
              pipe_(present, Str.startsWith(`${run.base}/collie-test-`)),
            ),
          ),
        ).toBe(true);
      }),
    ));

  test("under tmpdir() where the memory filesystem is missing or nearly full", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const memory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-" });
        const room = () => MEMORY_FREE_BYTES;
        expect(rootBase(memory, "/fallback", room)).toBe(memory);
        expect(rootBase(memory, "/fallback", () => MEMORY_FREE_BYTES - 1)).toBe("/fallback");
        expect(rootBase(`${memory}/missing`, "/fallback", room)).toBe("/fallback");
        yield* fs.chmod(memory, 0o555);
        expect(rootBase(memory, "/fallback", room)).toBe("/fallback");
        yield* fs.chmod(memory, 0o755);
      }).pipe(Effect.scoped),
    ));
});

describe("the start-of-suite sweep", () => {
  test("removes a dead suite's root on the memory filesystem too", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const memory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-" });
        const gone = Bun.spawn(["true"]);
        yield* Effect.promise(() => gone.exited);
        const dead = `${memory}/collie-test-${gone.pid}-x`;
        yield* fs.makeDirectory(dead);
        expect(sweepEveryBase(memory)).toContain(dead);
        expect(yield* fs.readDirectory(memory)).toEqual([]);
      }).pipe(Effect.scoped),
    ));

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

  test("a process read while it execs is found once its new program has its environment", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const proc = yield* fs.makeTempDirectoryScoped({ prefix: "proc-" });
        const pid = `${proc}/4242`;
        // proc(5) fields 3 on; 51, env_end, is 0 until execve has written the environment.
        const stat = (envEnd: string) =>
          `4242 (sh) R 1 4242 4242 0 -1 4194304${pipe_(" 0", Str.repeat(41))} ${envEnd} 0\n`;
        yield* fs.makeDirectory(pid);
        yield* fs.writeFileString(`${pid}/stat`, stat("0"));
        yield* fs.writeFileString(`${pid}/environ`, "");
        yield* fs.writeFileString(`${pid}/cmdline`, "");
        yield* fs.writeFileString(`${pid}/stat.next`, stat("140730872492009"));
        yield* fs.writeFileString(`${pid}/environ.next`, `PATH=/bin\0${MARKER}=/root-a\0`);
        yield* fs.writeFileString(`${pid}/cmdline.next`, "sleep\x0063\0");
        const exec = Bun.spawn([
          "sh",
          "-c",
          "sleep 0.3; cd $0; mv cmdline.next cmdline; mv environ.next environ; mv stat.next stat",
          pid,
        ]);
        yield* Effect.addFinalizer(() => Effect.promise(() => exec.exited));

        expect(marked("/root-a", {}, proc)).toEqual([{ pid: 4242, command: "sleep 63" }]);
      }).pipe(Effect.scoped),
    ));

  test("a process whose exec finishes between its empty environment read and its stat read is read again", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const proc = yield* fs.makeTempDirectoryScoped({ prefix: "proc-" });
        const pid = `${proc}/4242`;
        yield* fs.makeDirectory(pid);
        yield* fs.writeFileString(`${pid}/cmdline`, "sleep\x0063\0");
        yield* fs.writeFileString(`${pid}/environ.next`, `PATH=/bin\0${MARKER}=/root-a\0`);
        yield* fs.writeFileString(
          `${pid}/stat.next`,
          `4242 (sleep) S 1 4242 4242 0 -1 4194304${pipe_(" 0", Str.repeat(41))} 140730872492009 0\n`,
        );
        // FIFOs order the reads: environ reads empty, the exec finishes, then stat is read.
        yield* exec(["mkfifo", `${pid}/environ`, `${pid}/stat`]);
        const execs = Bun.spawn([
          "sh",
          "-c",
          "cd $0; : > environ; mv environ.next environ; cat stat.next > stat",
          pid,
        ]);
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => {
            execs.kill();
            return execs.exited;
          }),
        );

        expect(marked("/root-a", {}, proc)).toEqual([{ pid: 4242, command: "sleep 63" }]);
      }).pipe(Effect.scoped),
    ));
});
