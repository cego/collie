import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { checkProof, owedLocally } from "../src/check-proof";
import { evidenceGaps, type Collected } from "../src/outcome";
import { settleFinalFix } from "../src/output";
import { TOO_LARGE, type CheckCommand, type Verification } from "../src/verify";
import type { VerifySpec } from "../src/verify-spec";
import type { YamlValue } from "../src/yaml";

const FINAL = { head_sha: "abc123", fingerprint: "tree-1" };
const TESTS: VerifySpec = { name: "tests", executable: "bun", argv: ["test"], cwd: "/repo" };
const COMMAND: CheckCommand = { ...TESTS, executable: "/usr/bin/bun" };

function record(over: Partial<Verification> = {}): Verification {
  return {
    id: "tests-1",
    run: "r1",
    name: "tests",
    executable: "/usr/bin/bun",
    argv: ["test"],
    cwd: "/repo",
    start: FINAL,
    end: FINAL,
    exit: 0,
    seconds: 1,
    tail: { stdout: "", stderr: "" },
    expect: "pass",
    result: "pass",
    at: "2026-10-16T10:00:00.000Z",
    by: "collie",
    ...over,
  };
}

const proofOf = (
  verifications: ReadonlyArray<Verification>,
  over: { final?: typeof FINAL; commands?: ReadonlyArray<CheckCommand> } = {},
) => checkProof({ verifications, final: over.final ?? FINAL, commands: over.commands }, "tests");

test("a pass on this tree is the Check's proof", () => {
  const pass = record();
  expect(proofOf([pass])).toEqual({ state: "passed", runs: [pass], last: pass });
});

test("a fail on this tree is not, even after an earlier pass", () => {
  const fail = record({ id: "tests-2", result: "fail", exit: 1 });
  expect(proofOf([record(), fail])).toMatchObject({ state: "failed", last: fail });
});

test("a reproduced failure, expected to fail, is no pass", () => {
  expect(proofOf([record({ expect: "fail" })]).state).toBe("failed");
});

test("a run on a tree that moved under it is unstable", () => {
  const moved = { head_sha: "abc123", fingerprint: "tree-2" };
  expect(proofOf([record({ result: "unstable", start: moved })]).state).toBe("unstable");
});

test("a pass on an earlier fingerprint passed only on an earlier tree, and one on an earlier head of the same bytes passed here", () => {
  const end = { head_sha: "abc123", fingerprint: "tree-0" };
  const earlier = record({ start: end, end });
  expect(proofOf([earlier])).toEqual({ state: "earlier", runs: [earlier], last: undefined });
  const committed = { head_sha: "abc000", fingerprint: "tree-1" };
  const same = record({ start: committed, end: committed });
  expect(proofOf([same])).toEqual({ state: "passed", runs: [same], last: same });
});

test("on a tree too large to fingerprint, every record is unstable, and its sentences are as they were", () => {
  const large = { head_sha: "abc123", fingerprint: TOO_LARGE };
  const run = record({ result: "unstable", start: large, end: large });
  expect(proofOf([run], { final: large })).toEqual({
    state: "unstable",
    runs: [run],
    last: undefined,
  });
  expect(evidenceGaps("unspecified", collected([run], { final: large }))).toEqual([
    "tests ran on a tree that moved under it",
  ]);
  expect(fixReasons([run], large)).toEqual(['check "tests" ran on a tree that moved under it']);
});

test("an agent's record counts by name for a gap decider that counts anyone's, and not for the approved set", () => {
  const agents = record({ by: "agent" });
  expect(proofOf([agents]).state).toBe("passed");
  expect(checkProof({ verifications: [agents], final: FINAL }, "tests", "collie").state).toBe(
    "never",
  );
  expect(evidenceGaps("unspecified", collected([agents]))).toEqual(["tests was never run"]);
  expect(fixReasons([agents], FINAL)).toEqual([]);
});

test("an agent's record of exactly the Check's command counts for it", () => {
  const agents = record({ by: "agent" });
  const got = { verifications: [agents], final: FINAL, commands: [COMMAND] };
  expect(checkProof(got, "tests", "collie").state).toBe("passed");
});

test("a record of a different command under the Check's name is not its run", () => {
  const other = record({ argv: ["test", "--bail"] });
  expect(proofOf([other], { commands: [COMMAND] })).toEqual({
    state: "never",
    runs: [],
    last: undefined,
  });
});

test("a Check with no record was never run", () => {
  expect(proofOf([])).toEqual({ state: "never", runs: [], last: undefined });
  expect(proofOf([record({ name: "lint" })]).state).toBe("never");
});

test("every Check is owed a local run but one left to CI", () => {
  const lint: VerifySpec = { ...TESTS, name: "lint", argv: ["run", "lint"] };
  expect(owedLocally([TESTS, lint, NUXI])).toEqual([TESTS, lint]);
});

const NUXI: VerifySpec = {
  name: "nuxi",
  executable: "bunx",
  argv: ["nuxi", "typecheck"],
  cwd: "/repo",
  ci: "nuxi-typecheck",
};
const NUXI_COMMAND: CheckCommand = { ...NUXI, executable: "/usr/bin/bunx" };
const JOB = { name: "nuxi-typecheck", url: "https://gitlab.example.com/g/p/-/jobs/9" };
const jobPass = (over: Partial<Verification> = {}) =>
  record({
    id: "nuxi-ci",
    name: "nuxi",
    executable: "/usr/bin/bunx",
    argv: ["nuxi", "typecheck"],
    pass: "ci",
    job: JOB,
    ...over,
  });

test("a check left to CI waits on its job until its pass on this commit is recorded", () => {
  const nuxi = (verifications: ReadonlyArray<Verification>, final = FINAL) =>
    checkProof({ verifications, final, approved: [NUXI] }, "nuxi");
  expect(nuxi([]).state).toBe("waiting");
  // A local run of its command is no proof of it.
  expect(nuxi([jobPass({ pass: "gate", job: undefined })]).state).toBe("waiting");
  const earlier = { head_sha: "abc000", fingerprint: "tree-0" };
  expect(nuxi([jobPass({ start: earlier, end: earlier })]).state).toBe("waiting");
  // A job ran on its commit, so another commit of the same bytes still waits on its own.
  const sameBytes = { head_sha: "abc000", fingerprint: FINAL.fingerprint };
  const onAnotherCommit = jobPass({ start: sameBytes, end: sameBytes });
  expect(nuxi([onAnotherCommit]).state).toBe("waiting");
  expect(
    checkProof({ verifications: [onAnotherCommit], final: FINAL, commands: [NUXI_COMMAND] }, "nuxi")
      .state,
  ).toBe("waiting");
  const proved = jobPass();
  expect(nuxi([proved])).toEqual({ state: "proved", runs: [proved], last: proved });
  expect(
    checkProof({ verifications: [proved], final: FINAL, commands: [NUXI_COMMAND] }, "nuxi").state,
  ).toBe("proved");
});

test("a check left to CI moved to another job or command is not proved by its old job's pass", () => {
  const proved = jobPass();
  const proof = (one: VerifySpec) => [
    checkProof({ verifications: [proved], final: FINAL, approved: [one] }, "nuxi").state,
    checkProof(
      {
        verifications: [proved],
        final: FINAL,
        commands: [{ ...one, executable: "/usr/bin/bunx" }],
      },
      "nuxi",
    ).state,
  ];
  expect(proof(NUXI)).toEqual(["proved", "proved"]);
  expect(proof({ ...NUXI, ci: "new-job" })).toEqual(["waiting", "waiting"]);
  expect(proof({ ...NUXI, argv: ["nuxi", "typecheck", "--strict"] })).toEqual([
    "waiting",
    "waiting",
  ]);
});

test("no gap decider counts a check left to CI's missing local pass", () => {
  const passing = record();
  expect(evidenceGaps("unspecified", collected([passing], { approved: [TESTS, NUXI] }))).toEqual(
    [],
  );
  expect(
    Arr.filter(
      evidenceGaps(
        "feature",
        collected([passing], {
          approved: [TESTS, NUXI],
          tickets: [{ file: "01.md", checks: ["tests", "nuxi"] }],
          outputs: new Map<string, YamlValue>([["build", { tickets_done: ["one"] }]]),
          reviewed: new Set(["synthesize"]),
        }),
      ),
      (gap) => pipe(gap, Str.includes("nuxi")),
    ),
  ).toEqual([]);
  const settled = settleFinalFix(
    [],
    { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [{ name: "nuxi" }] },
    { verifications: [], final: FINAL, commands: [NUXI_COMMAND] },
  );
  expect(settled.ok).toBe(true);
  // A Run whose only Check is left to CI still names one.
  expect(evidenceGaps("unspecified", collected([], { approved: [NUXI] }))).toEqual([]);
});

function collected(
  verifications: ReadonlyArray<Verification>,
  over: Partial<Collected> = {},
): Collected {
  return {
    verifications,
    final: FINAL,
    approved: [TESTS],
    outputs: new Map<string, YamlValue>(),
    reviewed: new Set<string>(),
    insideRun: () => true,
    tickets: [],
    ...over,
  };
}

function fixReasons(verifications: ReadonlyArray<Verification>, final: typeof FINAL) {
  const settled = settleFinalFix(
    [],
    { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [{ name: "tests" }] },
    { verifications, final },
  );
  return settled.ok ? [] : settled.reasons;
}
