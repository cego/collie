import { expect, test } from "bun:test";
import {
  remainingDisputes,
  settleRound,
  splitDisputed,
  type Finding,
  type Fixed,
} from "../src/output";

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
    findings: Finding[];
    disputed: Finding[];
    dropped: Finding[];
    fixed: Fixed[];
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
