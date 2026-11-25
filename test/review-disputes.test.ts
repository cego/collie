import { expect, test } from "bun:test";
import {
  conflictingDispositions,
  remainingDisputes,
  settleRound,
  splitDisputed,
} from "../src/output";
import type { Finding, Fixed } from "../src/output";

const dispute: Finding = {
  file: "src/worker.ts",
  title: "Restore the requested scope",
  severity: "blocker",
  reason: "The recorded scope decision includes this change.",
};

const accepted: Finding = {
  ...dispute,
  reason: "The recorded decision and the diff confirm the requested scope.",
};

const review = (
  over: Partial<{
    findings: Array<Finding>;
    disputed: Array<Finding>;
    dropped: Array<Finding>;
    fixed: Array<Fixed>;
  }> = {},
) => ({ findings: [], disputed: [], dropped: [], fixed: [], ...over });

test("a review's reasoned withdrawal settles the carried dispute by file and title", () => {
  const synthesis = review({ dropped: [accepted] });
  const disputed = remainingDisputes([dispute], synthesis);
  const split = splitDisputed(synthesis.findings, disputed);
  expect(settleRound({ live: split.live, disputed, at: 2 })).toEqual({
    go: "clean",
    remaining: [],
  });
});

test("an omitted dispute remains unresolved even when the review has no findings", () => {
  const disputed = remainingDisputes([dispute], review());
  expect(settleRound({ live: [], disputed, at: 2 })).toMatchObject({
    go: "halt",
    halt: "dispute_unresolved",
  });
});

test("a review confirming the disputed finding is fixed clears that finding", () => {
  expect(
    remainingDisputes(
      [dispute],
      review({
        fixed: [{ file: dispute.file, title: dispute.title, note: "The correction is present." }],
      }),
    ),
  ).toEqual([]);
});

test("a withdrawal without a reason cannot settle a dispute", () => {
  for (const reason of [undefined, "", "  \n "]) {
    expect(remainingDisputes([dispute], review({ dropped: [{ ...accepted, reason }] }))).toEqual([
      dispute,
    ]);
  }
});

test("a withdrawal at another file does not settle a same-titled dispute", () => {
  expect(
    remainingDisputes([dispute], review({ dropped: [{ ...accepted, file: "src/other.ts" }] })),
  ).toEqual([dispute]);
});

test("a finding still raised or disputed cannot be erased by a conflicting withdrawal", () => {
  for (const synthesis of [
    review({ findings: [dispute], dropped: [accepted] }),
    review({
      findings: [{ ...dispute, rebuttal: "The decision excludes it." }],
      dropped: [accepted],
    }),
    review({ disputed: [dispute], dropped: [accepted] }),
    review({ findings: [dispute], fixed: [dispute] }),
  ]) {
    expect(remainingDisputes([dispute], synthesis)).toEqual([dispute]);
  }
});

test("accepting one dispute preserves the other and changes neither review nor carried findings", () => {
  const other = { ...dispute, title: "Handle an empty response" };
  const carried = [dispute, other];
  const synthesis = review({ dropped: [accepted] });
  expect(remainingDisputes(carried, synthesis)).toEqual([other]);
  expect(carried).toEqual([dispute, other]);
  expect(synthesis.dropped).toEqual([accepted]);
});

test("a dispute withdrawn with a reason is resolved though the same review echoes it as obsolete", () => {
  const synthesis = review({ findings: [{ ...dispute, status: "obsolete" }], dropped: [accepted] });
  expect(remainingDisputes([dispute], synthesis)).toEqual([]);
});

test("a dispute confirmed fixed is resolved though the same review echoes it as fixed", () => {
  const synthesis = review({
    findings: [{ ...dispute, status: "fixed" }],
    fixed: [{ file: dispute.file, title: dispute.title }],
  });
  expect(remainingDisputes([dispute], synthesis)).toEqual([]);
});

test("a withdrawn dispute raised again open with a changed detail is a renewed finding for the implementer", () => {
  const before = { ...dispute, detail: "The scope check runs after the write." };
  const renewed = { ...before, reason: undefined, detail: "The write at line 40 skips it too." };
  const synthesis = review({
    findings: [renewed],
    dropped: [{ ...accepted, detail: before.detail }],
  });
  const disputed = remainingDisputes([before], synthesis);
  expect(disputed).toEqual([]);
  const split = splitDisputed(synthesis.findings, disputed);
  expect(settleRound({ live: split.live, disputed, at: 2 })).toMatchObject({
    go: "fix",
    blocking: [renewed],
  });
});

test("a rebuttal that renames the finding puts it back with the fixer, and its dispute stops standing", () => {
  const stood: Finding = {
    id: "r-1-F1",
    file: "src/worker.ts",
    title: "Restore the requested scope",
    severity: "blocker",
    reason: "The recorded decision includes this change.",
  };
  const renamed: Finding = {
    id: "r-1-F1",
    file: "src/worker.ts",
    title: "Keep the requested scope in the write",
    severity: "blocker",
    rebuttal: "The write at line 40 still skips the check.",
  };
  const split = splitDisputed([renamed], [stood]);
  expect(split.standing).toEqual([]);
  expect(settleRound({ live: split.live, disputed: split.standing, at: 2 })).toMatchObject({
    go: "fix",
    blocking: [renamed],
  });
});

test("a dispute a review repeats as minor keeps its severity and takes the reviewer's latest detail", () => {
  const repeated: Finding = {
    ...dispute,
    status: "disputed",
    severity: "minor",
    detail: "The write at line 40 skips the check.",
  };
  const split = splitDisputed([repeated], [dispute]);
  expect(split.standing).toEqual([{ ...dispute, detail: "The write at line 40 skips the check." }]);
});

test("a finding withdrawn and raised open with the same evidence in one review is a conflict, and its dispute stays", () => {
  const synthesis = review({ findings: [{ ...dispute, reason: undefined }], dropped: [accepted] });
  const disputed = remainingDisputes([dispute], synthesis);
  expect(disputed).toEqual([dispute]);
  expect(conflictingDispositions(synthesis)).toEqual([
    "conflicting dispositions of [blocker] Restore the requested scope (src/worker.ts): open and withdrawn",
  ]);
  const split = splitDisputed(synthesis.findings, disputed);
  expect(settleRound({ live: split.live, disputed, at: 2 })).toMatchObject({
    go: "halt",
    halt: "dispute_unresolved",
  });
});
