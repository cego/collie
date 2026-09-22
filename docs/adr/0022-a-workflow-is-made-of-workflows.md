# A workflow is made of workflows, and a project brings its own services

**Status: accepted, and proven against real hosts, two projects at a time, over real
SQLite.** The seams are `src/sdk.ts` (`child` and `NativeChildren`), `src/native.ts` (the
registry's `resolve` and the composition root in `register`) and `src/host.ts` (the search
path it is given). The proof is `test/children.test.ts`.
[ADR-0016](0016-a-workflow-module-is-found-where-it-was-saved.md) settled where a module is
found; this is what a module found there may be made of.

## Decision

**D1. A shared contract with two implementations is a service with two Layers.** There is
no binding table, no override registry and nothing resolved at run time. A module provides
what it needs with `Layer.provide`, the host builds that Layer once per loaded generation,
and two projects running at once are two Layers that never meet. What makes them the same
contract is the service's key, not the file that declared it — so two copies of a contract
in two directories are two modules and one service.

**D2. The composition root binds one thing, and binds it explicitly.** `NativeChildren` is
provided into each module's own Layer where that Layer is built, beside the engine, the
host and the agents. It is passed to the generation rather than left somewhere a module
could find it, because a service something looks itself up in is the thing this decision
exists to not have.

**D3. A child is selected in the parent's project, not in the host's memory.** The host is
given its search path rather than reaching for one, and a start from a front door and a
child from a parent go through the same `resolve`. A host with no search path — the fixture
host — has only what was loaded into it. Without this, two projects sharing one host would
have their parents' children decided by whichever of them loaded that module last.

**D4. Importing a file is the deliberate opposite.** A function imported from beside a
module is that file's, chosen by where the module was saved and by nothing else. Both ways
of reaching a contract are wanted: one follows the project, one follows the author.

**D5. The invocation is the child's identity.** A child's Run id is its parent's and what
the parent called that invocation, so replaying a parent asks for the child it already has
and native idempotency hands back the same execution. A different name is a different
child; giving one invocation different arguments later is refused rather than run twice.

**D6. The child's own schema decides before anything exists.** A parent's field may be
wider than the child's, and the child is the authority. Input it will not take is the
parent's failure, naming the field, with no row, no execution and nothing to clean up.

**D7. The parent hands its own children over.** A child's row is written accepted where it
is admitted, because the parent's own execute is what dispatches it. A host sweep
dispatching one would give the engine a child with no parent to wake, and the recorded
dispatch cannot be replaced afterwards.

**D8. A workflow reports its own failure in its own words.** A poll of a failed Run now
carries `WorkflowError`'s `reason` rather than the first line under it, so a child refusing
input names the field at the parent instead of reading as an empty error.

## What this does not decide

Nothing here is a step, a graph or a patch. How many children there are and in what order
is the author's TypeScript, and reordering one is editing a loop. Fan-out over repositories,
the baseline's enumeration and the board's cards are unchanged and are C6's and C7's.

## Consequences

An invocation named after a list position hands one item's child to another when the list
is reordered between attempts. The SDK takes any string and says so in `docs/sdk.md`;
naming the work is the author's to get right, and a name is the only thing that could be.

A child blocks the parent's fiber until it settles or suspends, which is upstream's own
child execution: a suspended child suspends its parent, and the child's completion wakes
it. Starting several before waiting on any is `children.start` then `children.result`.
