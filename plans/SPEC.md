# Spec — Harden herdr-plugin's local workflow runtime

**Status:** approved for local ticketing  
**Planned at:** commit `8533866`, 2026-08-31  
**Scope source:** improve audit findings 1–3 and 5–9. Release publication is explicitly excluded.

## Problem Statement

herdr-plugin successfully drives agent Workflows, but several local-runtime boundaries do not yet uphold the guarantees described by its own domain model. A project or user Workflow can derive paths that escape its Run directory; two drivers can race to own one Run; a stale process id can identify and stop an unrelated process; and a Hand-off written into a receiving Run can be lost when that Run's active Driver next saves its older in-memory state.

The contributor experience also has avoidable friction. Some shell/process boundaries fail when local directories contain spaces or shell metacharacters, the test suite takes roughly two minutes despite the repository's small size, the documented local checks omit the CI typecheck, and canonical documentation has drifted from accepted decisions and the shipped Pi Harness adapter.

Together these gaps make the local audit trail less reliable, allow malformed definitions to write outside their intended state area, make process control unsafe in edge cases, and slow or mislead both human and agent contributors.

## Solution

Strengthen the existing local runtime at its current seams rather than introducing a new subsystem:

- Reject Workflow-controlled names that cannot safely identify files or directories inside a Run.
- Give each Run exactly one atomic Driver ownership claim and ensure stop operations act only on that verified Driver.
- Make Hand-off persistence merge-safe while another Driver is actively updating the receiving Run.
- Pass executable paths and shell-visible paths without lossy space splitting or unquoted interpolation.
- Preserve the current broad behavioural coverage while reducing test process and polling overhead enough to provide a materially faster feedback loop.
- Make the local typecheck a named, documented command matching CI.
- Reconcile canonical vocabulary and Harness documentation with accepted ADRs and shipped behaviour.

All work remains local to the repository. Nothing is published to GitLab, Linear, or another issue tracker.

## User Stories

1. As a developer running a project-provided Workflow, I want every Step identifier to be validated before the Run starts, so that a malformed definition cannot write outside the Run directory.
2. As a developer running a project-provided Workflow, I want every declared Output name to be validated before an agent starts, so that generated Output paths remain inside the Step directory.
3. As a developer using parallel variants, I want variant-derived directory names to remain safe regardless of Harness or Model spelling, so that provider-qualified Model names cannot alter the directory hierarchy unexpectedly.
4. As a Workflow author, I want validation errors to name the invalid Workflow, Step, and field, so that I can correct a definition without inspecting runtime failures.
5. As a Workflow author, I want valid existing definitions to keep working unchanged, so that hardening does not invalidate the baseline or ordinary user forks.
6. As an operator, I want a Run to have at most one Driver, so that resume cannot start competing processes against the same agents and state files.
7. As an operator invoking resume twice concurrently, I want one attempt to acquire the Run and the other to stop cleanly, so that check-then-write races cannot duplicate execution.
8. As an operator, I want a stale ownership record to be recoverable when its Driver is gone, so that crashed Runs can still be resumed.
9. As an operator, I want the Control Plane's stop action to signal only the Driver that owns the selected Run, so that PID reuse cannot terminate an unrelated local process.
10. As an operator, I want Driver ownership to be released after normal completion, failure, and handled termination, so that completed or failed Runs are not falsely reported as active.
11. As an operator, I want a received Hand-off to remain in the receiving Run's audit trail while that Run continues changing state, so that later Driver saves cannot erase the exchange.
12. As an operator, I want both the sending and receiving Runs to record the same Hand-off identity and timestamp, so that the local audit trail can be correlated in either direction.
13. As an operator, I want a failed attempt to update the receiving audit trail to remain visible on the sender without corrupting either Run, so that degraded recording does not lose the primary record.
14. As a developer with a checkout or plugin state directory containing spaces, I want Driver startup to work normally, so that installation location does not constrain usage.
15. As a developer opening a Run log from the Control Plane, I want the exact log path passed safely to the shell, so that spaces and shell metacharacters are treated as path characters rather than syntax.
16. As a maintainer, I want process-launch overrides to have an unambiguous argument contract, so that test and development commands do not depend on naive whitespace splitting.
17. As a contributor, I want the full test suite to finish materially faster than the current approximately 124-second baseline, so that iterative changes receive timely feedback.
18. As a contributor, I want faster tests to preserve behavioural coverage at the Driver, Session, Hand-off, and Workflow boundaries, so that speed does not come from deleting valuable integration assertions.
19. As a contributor, I want a named local typecheck command, so that I can run the same TypeScript gate as CI without remembering an ad hoc command.
20. As a contributor, I want the development documentation to list tests and typechecking before the binary build, so that following the documented workflow reaches the same quality bar as CI.
21. As an agent reading the domain glossary, I want plan artefacts described as Run-local, so that I do not recreate the retired repository `tasks/` design.
22. As an agent reading the domain glossary, I want all baseline Workflows represented, including architecture, so that planning and implementation use the shipped vocabulary.
23. As a user choosing a Harness, I want Pi listed with its Model, Persona, and effort controls, so that every shipped adapter is discoverable from the same reference table.
24. As a maintainer, I want documentation-only corrections to avoid changing runtime behaviour, so that domain clarification can land independently and safely.
25. As a maintainer, I want each hardening slice to remain independently testable and reviewable, so that the work can be delivered incrementally without a long-lived integration branch.

## Implementation Decisions

- The existing definition validation boundary remains the authoritative place to reject unsafe names. A Run must not be created for a definition containing an unsafe Step identifier, Output filename, Persona-derived filename component, or variant-derived directory component.
- Safe Workflow-controlled names are single path components. They must not be empty, absolute, `.` or `..`, contain path separators, or normalize outside their intended parent. Existing baseline identifiers and provider-qualified Models must continue to work through safe encoding where necessary rather than broad prohibition.
- Directory containment is enforced defensively at the Run path-construction boundary as well as through definition validation. Validation provides useful early errors; containment prevents future callers from bypassing the invariant.
- Driver ownership uses an atomic acquisition operation, not a separate liveness check followed by a write. Failure to acquire means another Driver owns the Run and the new process exits without executing Workflow steps.
- Ownership records carry enough identity to distinguish the owning Driver from an unrelated process that later reuses the same PID. Stop and liveness checks must fail closed when identity cannot be verified.
- Ownership cleanup must be conditional: a Driver removes only the ownership record it acquired. A losing or superseded process must never clear another Driver's claim.
- The existing Run record remains the canonical Run snapshot. Cross-process Hand-off updates must use a merge-safe persistence operation so that an active Driver's later saves preserve externally appended Hand-offs.
- Hand-offs receive a stable identity suitable for deduplication during merges. Saving the same exchange twice must not duplicate it.
- Process launch uses structured executable and argument values. The default compiled Driver path is passed as one executable path, and development/test overrides use an explicit argument representation rather than general-purpose shell parsing.
- Commands intentionally sent to an interactive pane remain shell strings and use the repository's existing shell-quoting convention for every interpolated path.
- Test acceleration should first remove avoidable subprocess startup and fixed polling delay from the fake Herdr boundary. Production polling defaults are not weakened merely to make tests faster.
- The performance acceptance threshold is based on the full local suite on the same development machine used for the approximately 124-second baseline. The target is at most 60 seconds, with a stretch target of 30 seconds, while retaining all existing behavioural tests.
- Typechecking is exposed as a package script and CI calls that same script, eliminating command drift.
- Documentation uses the existing glossary terms Workflow, Step, Run, Driver, Session, Hand-off, Layer, Harness, Model, Input, Output, and Control Plane.
- The accepted decision that plan artefacts live under a Run remains unchanged.
- No new runtime dependency is introduced unless the standard library cannot provide atomic file creation, safe path handling, process identity verification, or argument passing required by this specification.

## Testing Decisions

- Tests assert externally visible behaviour and persisted state, not private helper implementation.
- Definition safety is tested at the highest existing seam: resolving and validating a Workflow. Tests cover traversal components, separators, absolute-looking names, safe provider-qualified Models, and unchanged baseline definitions.
- A focused defence-in-depth test proves that Run path construction cannot return a location outside the Run even if called with an unsafe component.
- Driver coordination is tested through the headless Driver/Run boundary. Two concurrent acquisition attempts must produce exactly one owner and one clean refusal.
- Stop safety is tested with a live unrelated process and a stale or mismatched ownership record. The unrelated process must remain alive.
- Ownership cleanup is tested for normal completion, failure, and a process that did not acquire ownership.
- Hand-off persistence is tested with two independently loaded representations of the same receiving Run: after the Hand-off is recorded and the original Driver representation saves again, the received Hand-off must remain exactly once.
- Path handling follows the existing headless process tests, but runs with temporary plugin, project, state, and log directories containing spaces and shell metacharacters.
- Test-suite optimization retains the existing end-to-end Workflow assertions. Before and after timings are captured with the same full-suite command; no test is skipped or weakened solely to meet the threshold.
- Repository-contract verification runs the named test and typecheck scripts. CI must invoke those same scripts successfully.
- Documentation changes are checked against the accepted plan-artefact ADR, the baseline Workflow definitions, and the Harness adapter registry. Lightweight assertions may be added only where they prevent the same factual drift from recurring.

## Out of Scope

- Publishing version tags, release assets, or packages.
- Changing the repository namespace or installation URL.
- Exercising or changing remote GitLab side effects such as opening merge requests or posting review notes.
- Configuring or validating Linear MCP integration.
- Replacing the Run JSON format wholesale or introducing a database.
- Redesigning the Workflow definition language beyond validating and safely encoding path-related fields.
- Changing production polling intervals solely to improve test duration.
- Adding a formatter, linter, pre-commit framework, or new general-purpose dependency.
- Changing Harness behaviour beyond documenting Pi and safely representing Driver launch arguments.
- Editing generated runner binaries as part of ordinary implementation steps; binary regeneration is a final verification/release concern only.

## Further Notes

- The repository was clean when planning began and was one commit ahead of `origin/master` at `8533866`.
- The verification baseline at planning time was 232 passing tests, zero failures, and a clean TypeScript no-emit check.
- Correctness and safety work should land before test-harness optimization so faster feedback is built around the final coordination contracts.
- This specification and its tickets are local planning artefacts under `plans/`; they must not be published without a separate explicit request.
