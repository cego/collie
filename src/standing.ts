// What became of a Run's work, from what it left behind rather than from what ran it.
//
// A card says whether work is waiting on a human, ready to build from, or landed, and
// none of that may be read off a workflow's name: a project's own workflow that opens a
// merge request leaves exactly as much to land as the shipped one, and a fork that
// renames `plan` still writes tickets. So the facts are the branch, the merge request,
// the tickets and whatever a human or the forge has since said about them.

/** What a Run left behind, as a card reads it. */
export interface WorkFacts {
  /** Whether it is over, whichever way it ended. */
  readonly settled: boolean;
  readonly succeeded: boolean;
  readonly branch: string | null;
  readonly mr: string | null;
  /** What the merge request became, where anything could say: merged or closed is an answer. */
  readonly mrLanded: boolean;
  /** How many tickets it wrote, which is what makes a plan work to build from. */
  readonly planIssues: number;
  /** Somebody said what became of this work. */
  readonly disposed: boolean;
  /** A question of its own that nobody has answered. */
  readonly asking: boolean;
}

/** Whether this Run left anything anyone has to file: work to land, or work to build from. */
export function filed(facts: Pick<WorkFacts, "branch" | "mr" | "planIssues">): boolean {
  return facts.branch !== null || facts.mr !== null || facts.planIssues > 0;
}

/** How a card stands: what there is to file, what to build from, and what is over. */
export interface Standing {
  /** Ended leaving nothing anyone could file. Fifty such cards are not fifty obligations. */
  readonly unfiled: boolean;
  /** Succeeded with tickets and nothing else outstanding: somebody can build from it. */
  readonly planReady: boolean;
  readonly landed: boolean;
}

export function standingOf(facts: WorkFacts): Standing {
  const unfiled = facts.settled && !filed(facts) && !facts.asking;
  const planReady =
    facts.succeeded &&
    facts.planIssues > 0 &&
    facts.branch === null &&
    facts.mr === null &&
    !facts.disposed;
  return { unfiled, planReady, landed: facts.disposed || facts.mrLanded || unfiled };
}
