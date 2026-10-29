import * as Arr from "effect/Array";
export function askRouteTo(
  planner: { readonly agent: string; readonly runId: string } | null,
): string {
  if (!planner) {
    return Arr.join(
      [
        "There is no planner live for this work. If you need a decision the plan does not",
        "cover, make it, and record it and why under `assumptions` in your Output.",
      ],
      " ",
    );
  }
  return Arr.join(
    [
      `The planner that wrote this plan is still live as agent \`${planner.agent}\` of Run \`${planner.runId}\`.`,
      `If you need a decision the plan does not cover, ask with collie_do deliver to ${planner.runId}, agent ${planner.agent},`,
      `or \`collie run steer ${planner.runId} --operation ${planner.agent} "<your question>"\`. Its answer comes back as a Delivery. If it cannot answer, decide, and`,
      "record it under `assumptions` in your Output. Ask it for one authority: an answer in the pane with the tickets left alone, or",
      "the answer written into the ticket and the pane saying only that it amended it. Its",
      "pane answer may be narrower than what it wrote, so where it says it changed a ticket,",
      "re-read that ticket and build from it.",
    ],
    " ",
  );
}
