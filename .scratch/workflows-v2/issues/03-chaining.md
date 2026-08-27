# 03: Chaining with run:

**What to build:** A choice with `run: <workflow>` and `inputs:` starts a child Run in the same workspace with the forwarded inputs; the parent run records the child id and finishes. Resume lists parent and child independently.

**Blocked by:** 02

**Status:** done

- [x] child run created with forwarded inputs, parent marked done with child link (tested)
- [x] validation fails fast when the chained workflow or its inputs are unknown
- [x] live: plan → Implement now opens implement tabs (run under 06, which supplies plan v2's menu)

## Decisions where the design was silent

- **The child inherits the parent's name**, not the forwarded input's value:
  `plan-add-a-picker` chains `implement-add-a-picker` instead of a run named after a
  40-character state-dir path.
- **Inputs the parent did not forward are inferred, then asked** in the runner pane.
  Cancelling that question abandons the chain and brings the menu back — nothing is
  half-created.
- **`run.json` records both directions**: `parent` on the child, `children` on the
  parent, and the summary prints the child id.
- **Steps after a chaining Choice are left `pending`** with the note "not run: chose …",
  so the audit trail says why they never ran. The parent's status is `done`, so `resume`
  offers only the child.
- **The chained workflow is validated when its *caller* is**, so a broken `implement`
  fails before `plan` opens a tab. Its own steps are validated again when the child run
  starts.
