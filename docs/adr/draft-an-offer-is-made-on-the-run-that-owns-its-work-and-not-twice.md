# An offer is made on the Run that owns its work, and not twice

**Status: accepted, to be built.** Builds on
[ADR-0025](0025-a-card-is-facts-and-an-offer-is-a-declaration.md) (an offer is a declaration,
decided again when invoked),
[ADR-draft-a-merge-request-is-released-on-a-humans-go](draft-a-merge-request-is-released-on-a-humans-go.md)
D2 (a succeeded implement Run with an open merge request offers `Release`) and on
run-ac644eef's Ready to ship draft, not yet landed (the card's Merge action invokes that
offer).

On 2026-11-11 an Improvement's implement Run ended at PR #347 with `then: finish`, as
designed. Its card showed Open PR and no Release, because the board draws an offer only for a
ready plan. Its Flow showed "What next · Not run", a step the Run's own input said it would
never reach. Release was found only through chat. Nothing would have refused a second Release
started from the card while chat's was running, or one started after the PR merged
(run-bb0f7142's diagnosis).

## Decision

**D1. A shipping offer is invoked on the Run that owns the merge request.** A Task can owe
several merge requests, one for each Change in a fan-out, and its leading Run may own none.
Every front door invokes `Release` or `Stage` on the Run that carries the merge request. This
covers the card, the Flow, the Run's detail, the CLI and chat. It never invokes them on the
leading Run by default.

**D2. An offer is refused while a Run doing its work is still going.** Two Runs count:

- a Run of the offer's workflow started from the same Run. A second follow-up would share
  the first one's checkout.
- a Run of the offer's workflow started with the same merge request this offer would fill.
  This holds whichever Run started it: another Run carrying the same merge request, the
  implement Run's own `then=release`, or a start from the CLI.

The refusal names that Run. Once that Run has failed, the offer is open again. The rule is
read from the declaration and from what the store records of each Run: its workflow, its
parent and its input. Nothing reads a workflow's name (ADR-0029).

An invocation on a Run that is not the one D1 chooses is neither redirected nor refused for
that reason alone: it acts on the Run it names. D2 is what keeps one merge request from being
released twice, not D1.

**D3. An offer that fills `merge-request` from the Run is refused once the forge reads that
merge request merged.** The refusal says so. An unknown forge answer refuses nothing, and
`release` still checks the merge request at its own start.

**D4. An offer whose connection is unusable is listed with that connection's reason.** Today
such an offer is dropped without a word. ADR-0025 already lists the other refused offers with
a reason.

**D5. A Run forecasts only the Steps its input and facts let it reach.** A Step a Run skips by
design is left out of its forecast, as soon as the Run knows it will skip it. It is not drawn
as "Not run". "Not run" stays the word for a Step that an ended Run expected and did not
reach.

## Consequences

- An unattended Run still asks nobody anything: Improvements, `plan then=implement`, a
  fan-out's Change Runs and `then=finish`. The human still finds Release on the card. The
  Release Run still asks its own Go.
- Card and chat can no longer start two Releases of one merge request at once.
