# A Run's checks are run by its gate

Agents recorded six whole-suite verifications in one window, 135 minutes in all, and all six
failed (cego/collie#128). run-b4b7cc99.implement ran `bun run check` twice, 1,152 s and
1,950 s, although the prompts for those tickets said the whole suite is the gate's. Its run
held the suite lock and 16 workers while other Runs' gates queued behind it. The rule was
prose only: `AGENTS.md`, `workflows/implement.md`, `workflows/review.md` and the implementer
persona. A last fix's gap even told the agent to "run it through collie verify".
`collie verify` reused a pass on the same tree and ran everything else.

## Decision

**D1. `collie verify` never runs one of the Run's Checks.** Given a command that is one of
the Run's Checks, matched as a record is already matched to its check (the executable,
arguments and directory the check resolves to), it answers with that Check's latest record
on this tree, passed or failed, with its log, and runs nothing. Where the tree has no record
of it, it refuses with `invalid_state` and names the gate: Collie runs that check itself, on
the final tree.

**D2. It binds every caller.** A human's `collie verify --run` is answered the same way as
an agent's. What it protects is the Machine's cores and the suite lock other Runs' gates
wait for, and a human's suite costs those as much as an agent's does. A human who wants the
suite anyway runs it outside `collie verify`, where it records nothing against the Run, or
resumes the Run so its gate runs it.

**D3. A Check is matched by the Run's Checks, never by a script name.** Collie does not know
which of a repository's commands is its whole suite, and `test` means a whole suite in one
repository and a quick check in another. A command that is not one of the Run's Checks runs
unless D5 answers it. In Collie's own repository that leaves `bun run test` to the rule in `AGENTS.md`.

**D4. No gap asks an agent to run a Check.** A Check with no record on the tree says the
gate runs it, rather than telling the agent to.

**D5. A command already recorded on this tree is answered, not run again.** Reviewers ran
commands the builder had recorded minutes earlier on the identical tree, although their
prompt listed those records (cego/collie#282). Where the latest record of the same command,
name and expectation on this tree, in the same environment and collected by this host,
passed or failed, `collie verify` answers with it as it answers a Check. An `unstable`
record answers nothing. `--again` runs it anyway, for a suspected flake; it never runs a
Check.

## Consequences

- An agent sees the result the gate saw, at once and for nothing, and cannot hold the suite
  lock a gate is waiting for.
- A Check named in a fix's `checks` is read from the gate's record on that tree. A fixer
  that has none to cite names the targeted verifications it ran.
- A whole suite started some other way, such as a bare `bun test` or another script, is not
  caught. The prose rule still covers those.
