# A check left to CI is proved by its pipeline job

In the monorepo, `nuxi typecheck` (`vue-tsc -b`) for one app used more than 15 CPU-minutes
on a loaded vm-mk, and run-33c8f85a's gate and agents ran it locally. CI's whole
nuxi-typecheck job takes 357 s. Collie's implement gate runs every Check before a merge
request exists. Every push before the `mr` step skips CI (`-o ci.skip`), so no pipeline has
run when the gate decides. Collie already reads a merge request's pipeline from its forge,
but only for the board's "Ready to release".

## Decision

**D1. A Check may name the pipeline job that proves it.** A Check's entry takes
`"ci": "<job name>"` in any Checks file: the project's `.collie/verify.json`, the checks
remembered for a remote, or the user's own. The entry keeps its executable and arguments.
They tell a human what the job runs. Collie never runs them.

**D2. Nobody runs a check left to CI locally.**

- The gate skips it, and its missing local pass is no gap.
- Agents see it in their prompts as left to CI and are told not to run it. They check what
  they touched with targeted commands, as they do for every Check.

**D3. Its proof is collected once the merge request is open.**

- After the `mr` step has pushed without `ci.skip` and opened or updated the merge request,
  the Run waits for the named job in the pipeline on the merge request's head commit.
- The job is read through the forge's adapter (ADR-0050).
- A pass on that commit is **Evidence**. Collie records it as a Verification of the check,
  bound to that commit, with the job's URL. Collie read it from the forge, so it is not a
  claim (ADR-0010).
- A pass on an earlier commit is an earlier tree.

**D4. A failing job is fixed like a failing check.**

- While the job is pending or running, the Run is Working and says which check, job and
  commit it is waiting on.
- A failed job goes to the builder with the job's URL and the adapter's command for its
  log, as a CI fix round. The builder fixes, commits and pushes without `ci.skip`, and the
  Run waits again.
- After the gate's round limit, the Run parks as an unproved gate does.
- The Run parks unproved, with the reason, in three cases: the pipeline on the head has no
  such job, the job was skipped or cancelled, or the checkout has no forge.
- A job missing because the merge request conflicts with its target branch is not a
  missing job: the forge runs no pipeline for a merge request it cannot merge. When the
  job is missing, Collie reads the merge request's mergeability through the same
  adapter. Where the forge says it conflicts, the check is unproved with that, marked
  as a conflict and naming no job, and gets no CI fix round: only the branch taking
  its target repairs it. Where the forge has not yet said whether it can merge, a
  caller that waits reads the job again, as pending.

**D5. The reviewer is told, not asked to run it.** A reviewer sees the check as "left to
CI: proved by `<job>` on the merge request's head". Where a merge request already exists, it
also sees the job's current state.

**D6. The Checks file is where a project says this.** A persona or a context file was
considered and rejected. The gate needs a structured fact, and agents would read prose that
the gate cannot.

## Consequences

- A slow whole-project check costs the Machine nothing locally. The Run finishes when the
  pipeline does.
- A checkout with no forge cannot leave a check to CI.
- With no Checks file, ADR-0055 still has the agent name checks from the CI config. A
  project that wants a check left to CI declares it.
- This follows the code where it disagrees with ADR-0010's amendment and
  `docs/workflows.md`. Those say an unproved gate opens the merge request anyway, but the
  implement Workflow parks instead.
