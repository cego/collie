import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { checkProof, owedLocally, owesNothingHere } from "../src/check-proof";
import { evidenceGaps } from "../src/outcome";
import type { Collected } from "../src/outcome";
import { settleFinalFix } from "../src/output";
import { TOO_LARGE, UNMEASURED } from "../src/verify";
import type { CheckCommand, Verification } from "../src/verify";
import type { VerifySpec } from "../src/verify-spec";
import type { YamlValue } from "../src/yaml";

const FINAL = { head_sha: "abc123", fingerprint: "tree-1" };
const TESTS: VerifySpec = { name: "tests", executable: "bun", argv: ["test"], cwd: "/repo" };
const COMMAND: CheckCommand = { ...TESTS, executable: "/usr/bin/bun" };

function record(over: Partial<Verification> = {}) {
  const returned: Verification = {
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
  return returned;
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

test("a stale pass reads earlier, a current fail reads failed, and a current expected-red record is no proof", () => {
  const EARLIER = { head_sha: "abc000", fingerprint: "tree-0" };
  expect(proofOf([record({ start: EARLIER, end: EARLIER })]).state).toBe("earlier");
  expect(proofOf([record({ result: "fail", exit: 1 })]).state).toBe("failed");
  const red = proofOf([record({ expect: "fail" })]);
  expect(owesNothingHere(red)).toBe(false);
  const settled = settleFinalFix(
    [],
    { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [{ name: "tests" }] },
    { verifications: red.runs, final: FINAL },
  );
  expect(settled.ok ? "(ok)" : settled.reasons).toEqual(["check failed: tests"]);
});

test("a stale expected-red record is history: the Check owes a pass, which the last fix leaves to the gate", () => {
  const EARLIER = { head_sha: "abc000", fingerprint: "tree-0" };
  const red = record({ expect: "fail", start: EARLIER, end: EARLIER });
  expect(proofOf([red])).toEqual({ state: "earlier", runs: [red], last: undefined });
  const settled = settleFinalFix(
    [],
    { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [{ name: "tests" }] },
    { verifications: [red], final: FINAL },
  );
  expect(settled.ok ? settled.attestation : settled.reasons).toContain(
    "0 check(s) verified on this tree, 1 left to the gate on the final tree (tests)",
  );
  expect(
    evidenceGaps("feature", collected([red], { tickets: [{ file: "01.md", checks: ["tests"] }] })),
  ).toContain('01.md promised check "tests", which has no passing verification on this tree');
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

test("an unstable check's gap names what moved, capped with a count and the record that lists them all", () => {
  const moved = { head_sha: "abc123", fingerprint: "tree-2" };
  const paths = Arr.map(Arr.range(1, 7), (n) => ({
    path: `out/${n}.txt`,
    change: "added" as const,
    class: "untracked" as const,
  }));
  const run = record({
    result: "unstable",
    start: moved,
    moved: [{ path: "bun.lock", change: "modified", class: "lockfile" }, ...paths],
  });
  const said = [...evidenceGaps("unspecified", collected([run])), ...fixReasons([run], FINAL)];
  expect(said).toHaveLength(2);
  for (const sentence of said) {
    expect(sentence).toContain(
      "ran on a tree that moved under it: modified lockfile bun.lock, added untracked out/1.txt",
    );
    expect(sentence).toContain("out/4.txt and 3 more (all 8 in verification tests-1)");
    expect(sentence).not.toContain("out/5.txt");
  }
});

test("a check on a tree git could not measure says git's reason, not that the tree moved", () => {
  const unmeasured = {
    head_sha: "abc123",
    fingerprint: UNMEASURED,
    unmeasured:
      "\nfatal: Unable to create index.lock: File exists.\nhint: Another git process seems to be running\n",
  };
  const run = record({ result: "unstable", end: unmeasured });
  const said = [...evidenceGaps("unspecified", collected([run])), ...fixReasons([run], FINAL)];
  expect(said).toHaveLength(2);
  for (const sentence of said) {
    expect(sentence).toContain("fatal: Unable to create index.lock: File exists.");
    expect(sentence).not.toContain("hint:");
    expect(sentence).not.toContain("moved under it");
  }
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
  // WARNING: A local run of the command is no proof; only the job's own commit counts.
  expect(nuxi([jobPass({ pass: "gate", job: undefined })]).state).toBe("waiting");
  const earlier = { head_sha: "abc000", fingerprint: "tree-0" };
  expect(nuxi([jobPass({ start: earlier, end: earlier })]).state).toBe("waiting");
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
  expect(evidenceGaps("unspecified", collected([], { approved: [NUXI] }))).toEqual([]);
});

function collected(verifications: ReadonlyArray<Verification>, over: Partial<Collected> = {}) {
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
