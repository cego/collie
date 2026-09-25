# A card is facts, and an offer is a declaration

**Status: accepted, and proven through the host's own operations, the command line and the
board.** The seams are `src/standing.ts` (what became of the work), `src/offers.ts` (what a
Run offers next), `src/cards.ts` (`kindForRole`), `src/definitions.ts` and
`workflows/*.md` (the declarations), `src/native.ts` and `src/host.ts` (`offers` and
`invoke`), and `src/operations.ts` (the same two for a Markdown Run). The proofs are
`test/actions.test.ts`, `test/offers.test.ts`, `test/standing.test.ts`,
`test/board.test.ts`, `test/ui/commands.test.ts` and the card test in
`test/engine-e2e.test.ts`.

## Decision

**D1. What became of the work is read from what it left behind.** A branch, a merge
request, tickets, a disposition and an open question are the facts; `standingOf` turns
them into landed, plan-ready or waiting. No workflow id and no step-name prefix takes part,
so a fork that renames `plan` still gets "Plan ready to implement." and a shipped `plan`
Run that wrote no tickets does not.

**D2. A card's kind is the role that did the work.** `kindForRole` reads the role a step
declared — the persona in a definition, the `role` a module gives `agentWork` — so a step
called `look` done by a reviewer writes a review card and one called `review-the-docs` done
by an implementer does not.

**D3. An offer is declared by the workflow, never known by Collie.** A module declares
`actions` and `followUps`; a Markdown definition declares `offers:` with a closed `needs:`
vocabulary over the same facts. "Fix what is open" is what the reviewing workflow says it
offers — generic code names no shipped workflow, and `self` is whatever the declaring
workflow is called today.

**D4. Every offer is decided again at the moment it is invoked.** Listing an offer is a
projection; invoking one re-reads the declaration from current code, asks the author's own
`eligible` about the facts as they are now, and decodes the arguments against the child's
schema. An offer edited away, one whose facts have moved and an argument the child refuses
each start nothing.

**D5. The eligibility function stays where it was written.** A module's `eligible` is the
author's code, so it is asked in the host that holds the module rather than projected into
a card. A function that throws takes its own offer off the card with the reason, not the
card off the board.

**D6. A disposition hides follow-ups and nothing else.** Work somebody has said what became
of is not work to carry on from. An action is given `disposed` among its facts and decides
for itself, because looking at what was merged is still worth offering.

**D7. Both front doors invoke the same thing.** `collie run actions` and `collie run
action` are the CLI's; the board's keys carry the same offer ids to the same operation. A
refusal is one sentence from one place, whichever door it came in.

**D8. A missing or broken module leaves the history readable.** Runs, cards and status are
still there; the offers are refused by name with the reason, because current code supplies
actions and there is none.

## What this does not decide

No condition parser: `needs:` is a closed list of facts, and anything outside it is not
expressible in a definition. No executor rebuilt from a source snapshot — an offer is what
the code says today or it is nothing. Cards gain no multi-repository launch: a plan that
spans repositories is still refused with the guidance it always had. The board's two keys
still show on the Run's own facts, and their labels are the board's; which workflow they
start is the declaration's.

## Consequences

`WorkflowDef` and `ResolvedWorkflow` gained `offers`, and the shipped `review` and
`implement` definitions declare what they have always done. A workflow that declares no
follow-up now says so rather than starting an `implement` nobody named.

`ActionFacts` is what a module is given; `OfferFacts` adds the two a definition may ask
about — findings left open, and what the Run was pointed at. Native Runs supply the facts a
host has today; as they gain branches, merge requests and plans of their own, the same
declarations start answering differently without anything here changing.
