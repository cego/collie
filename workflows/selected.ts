import type { FollowUp } from "collie";

// WARNING: nothing in src/ names these offers, so a Run renamed by a fork still offers what it found.
export const implementSelected: FollowUp = {
  id: "implement-selected",
  title: "Implement selected",
  workflow: "implement",
  when: "succeeded",
  selects: "many",
  inputs: { plan: "run-dir", findings: "findings" },
  eligible: (facts) => facts.openFindings > 0,
};

export const investigateFurther: FollowUp = {
  id: "investigate-further",
  title: "Investigate further",
  workflow: "investigate",
  when: "succeeded",
  selects: "one",
  inputs: { goal: "finding" },
  eligible: (facts) => facts.openFindings > 0,
};

export const planThis: FollowUp = {
  id: "plan-this",
  title: "Plan this",
  workflow: "plan",
  when: "succeeded",
  selects: "one",
  inputs: { goal: "finding" },
  eligible: (facts) => facts.openFindings > 0,
};

export const selected: ReadonlyArray<FollowUp> = [implementSelected, investigateFurther, planThis];
