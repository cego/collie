// A check's failed tests, read from its own output, and each run again alone (ADR-0034,
// amended 2026-10-15). Driven through the shipped host, as the gate asks for them.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Host, type WorkflowError } from "../src/sdk";
import { evidenceDir, foundationLayer } from "../src/engine";
import { Store } from "../src/store";
import { VerifySpecSchema } from "../src/verify-spec";
import { FakeBin } from "./support/bin";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";

let rig: Rig;
let dir: string;
const runId = "r-flake";

const asApproved = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(VerifySpecSchema))),
  Result.getOrThrow,
);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "t@example.com"],
        ["config", "user.name", "t"],
      ])
        yield* exec(["git", ...args], { cwd: rig.projectDir });
      yield* fs.writeFileString(`${rig.projectDir}/thing.ts`, "export const one = 1;\n");
      yield* exec(["git", "add", "-A"], { cwd: rig.projectDir });
      yield* exec(["git", "commit", "-qm", "first"], { cwd: rig.projectDir });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** bun's output for a run with two files, a nested describe, and `fail` failing tests. */
const bunPrinted = (options: { fail?: number; error?: boolean; extra?: number } = {}) =>
  Arr.join(
    [
      "bun test v1.3.0",
      "",
      "test/one.test.ts:",
      "(pass) one passes [1.00ms]",
      "error: expect(received).toBe(expected)",
      "      at <anonymous> (test/one.test.ts:9:3)",
      "(fail) the quick one breaks [2.00ms]",
      "",
      "test/two.test.ts:",
      "(fail) outer > inner > the nested one breaks [3.00ms]",
      ...Array.from({ length: options.extra ?? 0 }, (_, at) => `(fail) extra ${at} [1.00ms]`),
      "",
      "test/one.test.ts:",
      "(pass) one passes again [1.00ms]",
      "",
      `${2 + (options.extra ?? 0)} tests failed:`,
      "(fail) the quick one breaks [2.00ms]",
      "(fail) outer > inner > the nested one breaks [3.00ms]",
      "",
      " 2 pass",
      ` ${options.fail ?? 2 + (options.extra ?? 0)} fail`,
      ...(options.error === true ? [" 1 error"] : []),
      "Ran 4 tests across 2 files. [10.00ms]",
    ],
    "\n",
  );

/** Approves `unit`, a check that prints whatever `printed` holds and exits 1. */
const approveUnit = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(evidenceDir(dir, runId), { recursive: true });
      yield* fs.writeFileString(
        `${evidenceDir(dir, runId)}/approved.json`,
        asApproved([
          {
            name: "unit",
            executable: "sh",
            argv: ["-c", `cat ${rig.root}/printed >&2; exit 1`],
            cwd: ".",
          },
        ]),
      );
    }),
  ),
  Effect.orDie,
);

/** The gate's check of `unit` while it prints `printed`. */
const gateOn = (host: Host["Service"], printed: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${rig.root}/printed`, `${printed}\n`);
    return yield* host.verify({ runId, name: "unit", cwd: rig.projectDir, pass: "gate" });
  });

const inHost = <A>(
  body: (
    host: Host["Service"],
  ) => Effect.Effect<A, WorkflowError | PlatformError, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    yield* approveUnit;
    yield* (yield* Store).admit({
      request: `req-${runId}`,
      run: runId,
      workflow: "proof",
      project: rig.projectDir,
      input: {},
      provenance: {},
      options: {},
      generation: "proof@1",
      execution: `execution-${runId}`,
      task: null,
      parent: null,
    });
    return yield* body(yield* Host);
  }).pipe(
    Effect.provide(foundationLayer({ dir, userDir: rig.userDir })),
    Effect.scoped,
    Effect.orDie,
  );

test("a check that fails with bun's output records each failed test with its file", () =>
  runEffect(
    inHost((host) =>
      Effect.gen(function* () {
        const ran = yield* gateOn(host, bunPrinted());
        expect(ran.result).toBe("fail");
        expect(ran.failed).toEqual([
          { file: "test/one.test.ts", name: "the quick one breaks" },
          { file: "test/two.test.ts", name: "outer > inner > the nested one breaks" },
        ]);
      }),
    ),
  ));

test("output whose fail count does not match, that reports an error, or has over 20 failures names no tests", () =>
  runEffect(
    inHost((host) =>
      Effect.gen(function* () {
        for (const printed of [
          bunPrinted({ fail: 3 }),
          bunPrinted({ error: true }),
          bunPrinted({ extra: 19 }),
        ]) {
          const ran = yield* gateOn(host, printed);
          expect(ran.result).toBe("fail");
          expect(ran.failed).toBeUndefined();
        }
      }),
    ),
  ));

/** bun's output where a file's hook failed after `named` of its tests did; bun calls the hook `(unnamed)`. */
const hookFailed = (named: ReadonlyArray<string>) =>
  Arr.join(
    [
      "bun test v1.4.3",
      "",
      "test/one.test.ts:",
      ...Arr.map(named, (name) => `(fail) ${name} [30001.75ms]`),
      "(pass) one passes [1.00ms]",
      "",
      "test/two.test.ts:",
      "(pass) two passes [1.00ms]",
      "",
      "test/one.test.ts:",
      "error: The file left 1 thing(s) behind: directory /tmp/x",
      "(fail) (unnamed) [2527.44ms]",
      "",
      `${named.length + 1} tests failed:`,
      ...Arr.map(named, (name) => `(fail) ${name} [30001.75ms]`),
      "(fail) (unnamed) [2527.44ms]",
      "",
      " 2 pass",
      ` ${named.length + 1} fail`,
      "Ran 4 tests across 2 files. [10.00ms]",
    ],
    "\n",
  );

test("a check where a hook failed names no tests, even beside a named failure in its file", () =>
  runEffect(
    inHost((host) =>
      Effect.gen(function* () {
        for (const named of [["the slow one times out"], []]) {
          const ran = yield* gateOn(host, hookFailed(named));
          expect(ran.result).toBe("fail");
          expect(ran.failed).toBeUndefined();
        }
      }),
    ),
  ));

/** A `bun` on PATH that records its arguments and directory, prints `printed` and exits `exit`. */
const fakeBun = (printed: string, exit: number) =>
  Effect.gen(function* () {
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* bin.add(
      "bun",
      `pwd > ${rig.root}/bun-cwd; printf '%s\\n' "$@" > ${rig.root}/bun-argv; cat <<'PRINTED' >&2\n${printed}\nPRINTED\nexit ${exit}`,
    );
    return bin;
  });

const NESTED = { file: "test/two.test.ts", name: "outer > inner > the nested one breaks" };

test("a rerun runs bun test on the one test's file, matching its whole name, in the check's directory", () =>
  runEffect(
    Effect.gen(function* () {
      const bin = yield* fakeBun(" 1 pass\n 0 fail", 0);
      const ran = yield* inHost((host) =>
        host.verify({ runId, name: "unit", cwd: rig.projectDir, pass: "rerun", test: NESTED }),
      ).pipe(Effect.ensuring(bin.restore()));
      const fs = yield* FileSystem.FileSystem;
      const argv = ["test", `./${NESTED.file}`, "-t", "^outer inner the nested one breaks$"];
      expect(
        Arr.fromIterable(
          Str.split(Str.trimEnd(yield* fs.readFileString(`${rig.root}/bun-argv`)), "\n"),
        ),
      ).toEqual(argv);
      expect(Str.trim(yield* fs.readFileString(`${rig.root}/bun-cwd`))).toBe(
        yield* fs.realPath(rig.projectDir),
      );
      expect(ran).toMatchObject({ name: "unit", pass: "rerun", test: NESTED, argv, by: "collie" });
      expect(ran.result).toBe("pass");
    }),
  ));

test("a rerun passes only where bun exits 0 having run exactly one test, and it passed", () =>
  runEffect(
    Effect.gen(function* () {
      const bin = yield* fakeBun("", 0);
      const results = yield* inHost((host) =>
        Effect.forEach(
          [
            [`error: regex "^outer inner the nested one breaks$" matched 0 tests.`, 1],
            [" 2 pass\n 0 fail", 0],
            [" 0 pass\n 1 fail", 1],
          ] as const,
          ([printed, exit]) =>
            bin.add("bun", `cat <<'PRINTED' >&2\n${printed}\nPRINTED\nexit ${exit}`).pipe(
              Effect.andThen(
                host.verify({
                  runId,
                  name: "unit",
                  cwd: rig.projectDir,
                  pass: "rerun",
                  test: NESTED,
                }),
              ),
              Effect.map((ran) => ran.result),
            ),
        ),
      ).pipe(Effect.ensuring(bin.restore()));
      expect(results).toEqual(["fail", "fail", "fail"]);
    }),
  ));

const ODD = `import { describe, expect, test } from "bun:test";
describe("outer [x]", () => {
  describe("it's $HOME *", () => {
    test("the (one) asked for?", () => expect(1).toBe(1));
    test("the (one) asked for? too", () => expect(1).toBe(2));
  });
});
test("the (one) asked for?", () => expect(1).toBe(2));
`;

test("the real bun, rerun on a name holding a quote, brackets, $HOME, * and a nested describe, runs that one test", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${rig.projectDir}/test`, { recursive: true });
      yield* fs.writeFileString(`${rig.projectDir}/test/odd.test.ts`, ODD);
      const ran = yield* inHost((host) =>
        host.verify({
          runId,
          name: "unit",
          cwd: rig.projectDir,
          pass: "rerun",
          test: {
            file: "test/odd.test.ts",
            name: "outer [x] > it's $HOME * > the (one) asked for?",
          },
        }),
      );
      expect(ran.tail.stderr).toMatch(/^ 1 pass$/m);
      expect(ran.result).toBe("pass");
    }),
  ));

const QUICK = { file: "test/one.test.ts", name: "the quick one breaks" };

test("a test run at the base fails there only where bun reported that test failing, and runs once per base revision", () =>
  runEffect(
    Effect.gen(function* () {
      const bin = yield* FakeBin.make(`${rig.root}/bin`);
      const bun = (printed: string, exit: number) =>
        bin.add(
          "bun",
          `echo ran >> ${rig.root}/bun-runs; cat <<'PRINTED' >&2\n${printed}\nPRINTED\nexit ${exit}`,
        );
      const atBase = (host: Host["Service"], test: typeof QUICK) =>
        host.verify({ runId, name: "unit", cwd: rig.projectDir, at: "default-base", test });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${dir}/runs/${runId}`, { recursive: true });
      const [failed, again, missing, another] = yield* inHost((host) =>
        Effect.gen(function* () {
          yield* bun(
            `(fail) ${NESTED.name} [1.00ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file.`,
            1,
          );
          const failed = yield* atBase(host, NESTED);
          const again = yield* atBase(host, NESTED);
          yield* bun(`error: regex "^the quick one breaks$" matched 0 tests.`, 1);
          const missing = yield* atBase(host, QUICK);
          yield* bun(
            `(fail) ${NESTED.name} [1.00ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file.`,
            1,
          );
          return [
            failed,
            again,
            missing,
            yield* atBase(host, { ...NESTED, name: "another" }),
          ] as const;
        }),
      ).pipe(Effect.ensuring(bin.restore()));
      const head = Str.trim(
        (yield* exec(["git", "rev-parse", "HEAD"], {
          cwd: rig.projectDir,
        })).stdout,
      );
      expect(failed).toMatchObject({
        name: "unit",
        pass: "baseline",
        test: NESTED,
        result: "fail",
      });
      expect(failed.start.head_sha).toBe(head);
      expect(again.id).toBe(failed.id);
      // A test the base does not have is this Run's own.
      expect(missing).toMatchObject({ pass: "baseline", test: QUICK, result: "pass" });
      // Another test's failure is not this one's.
      expect(another.result).toBe("pass");
      expect(
        Str.split(Str.trim(yield* fs.readFileString(`${rig.root}/bun-runs`)), "\n"),
      ).toHaveLength(3);
    }),
  ));

test("a test run at the base fails there only where bun ran that one file and named that test failing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const same = (verdict: number) =>
        `import { expect, test } from "bun:test";\ntest("same test", () => expect(1).toBe(${verdict}));\n`;
      yield* fs.makeDirectory(`${rig.projectDir}/test`, { recursive: true });
      yield* fs.makeDirectory(`${rig.projectDir}/nested/test`, { recursive: true });
      yield* fs.writeFileString(`${rig.projectDir}/test/one.test.ts`, same(1));
      yield* fs.writeFileString(`${rig.projectDir}/nested/test/one.test.ts`, same(2));
      yield* exec(["git", "add", "-A"], { cwd: rig.projectDir });
      yield* exec(["git", "commit", "-qm", "same names"], { cwd: rig.projectDir });
      yield* fs.makeDirectory(`${dir}/runs/${runId}`, { recursive: true });
      const atBase = (host: Host["Service"], file: string) =>
        host.verify({
          runId,
          name: "unit",
          cwd: rig.projectDir,
          at: "default-base",
          test: { file, name: "same test" },
        });
      const [passing, failing] = yield* inHost((host) =>
        Effect.all([atBase(host, "test/one.test.ts"), atBase(host, "nested/test/one.test.ts")]),
      );
      expect(passing.result).toBe("pass");
      expect(failing.result).toBe("fail");
    }),
  ));

test("a test asked about at the base is asked again once its check runs in another directory", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${rig.projectDir}/package-b`, { recursive: true });
      yield* fs.writeFileString(`${rig.projectDir}/package-b/thing.ts`, "export const b = 1;\n");
      yield* exec(["git", "add", "-A"], { cwd: rig.projectDir });
      yield* exec(["git", "commit", "-qm", "package-b"], { cwd: rig.projectDir });
      yield* fs.makeDirectory(`${dir}/runs/${runId}`, { recursive: true });
      const bin = yield* fakeBun(`(fail) ${NESTED.name} [1.00ms]\n 0 pass\n 1 fail`, 1);
      const [first, moved] = yield* inHost((host) =>
        Effect.gen(function* () {
          const atBase = host.verify({
            runId,
            name: "unit",
            cwd: rig.projectDir,
            at: "default-base",
            test: NESTED,
          });
          const first = yield* atBase;
          yield* fs.writeFileString(
            `${evidenceDir(dir, runId)}/approved.json`,
            asApproved([{ name: "unit", executable: "bun", argv: ["test"], cwd: "package-b" }]),
          );
          return [first, yield* atBase] as const;
        }),
      ).pipe(Effect.ensuring(bin.restore()));
      expect(moved.id).not.toBe(first.id);
      expect(moved.cwd).toBe(`${first.cwd}/package-b`);
    }),
  ));
