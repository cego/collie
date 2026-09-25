# A strategy, not a field name

**Status: accepted, and proven by running the same workflow twice under two sets of names.**
The lookup is `src/strategies.ts`, the settling is `Native.settleInput`, and the proofs are
`test/strategies.test.ts` — the shipped names and an author's own, asserted to behave
identically — and `test/typed-inputs.test.ts`, which is what a caller types and what the
workflow is handed. [ADR-0018](0018-a-native-run-is-a-run.md) made a module's Run reachable
from both front doors; this is what those doors settle before they start one.

## Decision

**D1. What Collie does with an Input is the strategy's, never the field's name.** The
shipped workflows happen to call their work source `plan` and their diff target `target`.
Branch inference, the label a Run is listed under, a step's requirements, fan-out, the
previous review of the same change and the repository a roaming Run is cut from all find
the field by the strategy it was declared under. A workflow that calls them `spec` and
`change` behaves identically, and one that declares neither simply has neither.

**D2. A Run records which strategy settled each Input.** `input_strategies` is written at
creation from the definition the Run froze, so a reader needs neither the definition nor a
convention. A Run recorded before this build has none, and reads as a workflow that
declared no work source rather than as one whose `plan` field means something.

**D3. Two fields may not claim one exclusive strategy.** `work-source`, `diff-target` and
`gitlab-repository` are one field each, refused at load for a module and at validation for
a definition, because two claimants leave every reader above with no answer and picking one
by name is the thing renaming must not change.

**D4. A source's kind comes from its value, or from what settling it recorded.** A diff
target's kind is its value's own shape — `mr:`, `branch:`, a working tree — so it is read,
not stored. A work source's cannot be: telling a plan directory from a review directory
means looking at both, so that one is recorded when it is settled. Nothing reads a
`<name>_kind` sibling by name.

**D5. A module's inputs are schemas, and the schema settles the value.** `--input k=v` is
tried as text first and read as JSON only where the schema will not take the text, so a
string-or-number union takes the text and a number takes the number. `--inputs-json` is
typed and settles what text cannot, which is how `false`, `0`, `[]` and `null` are said at
all. Missing is absent: an input nobody gave is one the module never sees.

**D6. Settling happens before admission, in the host that has the module.** The schema
lives where the module was loaded, so the host decodes, and a value it refuses costs no
row, no claim, no execution, no worktree and no agent. What it refuses names the field and
what that field takes.

**D7. Host options are not the author's payload.** `branch`, `task`, `workspace`, `repo`,
`outcome`, `risks` and `previous` are Collie's to supply. A module may not declare one —
`checkEntry` refuses it at load — so a value under one of those names is an option, kept
beside the Run rather than injected into the input the workflow reads. An outcome a module
fixes cannot be asked for as another.

**D8. A front door asks the way the schema allows.** A module's declared fields travel with
their JSON Schema, so the picker offers a menu for a closed set and a yes/no for a boolean
rather than a text box, and a caller that has never seen the module gets `needs_input`
carrying each missing field's schema. Inference runs first where the module attached a
strategy to a field.

## What this does not decide

Agents, worktrees and Outputs belong to ticket 08; answering, holding and stopping a native
Run to 09; cards and actions to 13. `--decide`, `--goal` and `--constraint` stay refused on
a module until those tickets give them somewhere to go. Old Run records are not
reinterpreted: ticket 17's one-time import is where history gets its strategies, and
nothing here reads an old string as though it were typed.

## Consequences

- A roaming checkout is called `roaming` rather than after the workflow that first needed
  one. Existing checkouts under the old name are not moved; they are pruned as any other.
- `--inputs-json` may carry any JSON. A Markdown workflow's Inputs are text, so a value
  that is not a string is refused there rather than rendered into a prompt as nonsense.
- A module's field schemas must decode without services of their own, because a launch is
  settled before any of the author's Layers have been built. `InputFields` in the SDK says
  so in the type.
