// What one Run tells another, and how an agent is told where to take a question.
//
// A plan and the work that builds it are two Runs with two agents. When the second needs a
// decision the plan does not cover, the answer is worth more from the agent that wrote the
// plan and is still live than from a human reading it cold — so a prompt says which it is.

export function askRouteTo(
  planner: { readonly agent: string; readonly paneId: string } | null,
): string {
  if (!planner) {
    return [
      "There is no planner live for this work. If you need a decision the plan does not",
      "cover, stop, ask me in your own pane, and say in your Output that you are waiting.",
    ].join(" ");
  }
  return [
    `The planner that wrote this plan is still live as agent \`${planner.agent}\` in pane`,
    `\`${planner.paneId}\`. If you need a decision the plan does not cover, ask it rather than`,
    `stopping: \`herdr agent prompt ${planner.agent} "<your question>"\`, then read the answer`,
    `with \`herdr agent read ${planner.agent} --lines 40\`. Only stop and ask me if it cannot`,
    "answer. Ask it for one authority: an answer in the pane with the tickets left alone, or",
    "the answer written into the ticket and the pane saying only that it amended it. Its",
    "pane answer may be narrower than what it wrote, so where it says it changed a ticket,",
    "re-read that ticket and build from it.",
  ].join(" ");
}
