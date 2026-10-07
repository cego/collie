# Collie removes what it made once nothing needs it

**Status: accepted, not yet built.** Once built, it replaces three sentences:

- In [`CONTEXT.md`](../../CONTEXT.md) (Task workspace), the workspace is "made and focused"
  and "kept when the work is finished until the human closes it".
- In [ADR-0027](0027-one-engine-and-a-hard-cutover.md), "The old directories are neither
  read nor deleted."
- In **Settled**, the requirement that a merge request is "merged or closed", read
  only from GitLab.

It also stops a start from focusing the workspace it opens.

## What was true before

Collie made things and never removed them. On 2026-10-07 vm-mk's root filesystem was at
92%, with 26G free. What Collie had left behind:

- **Worktrees:** 58 under `~/.herdr/worktrees/.collie`, 25G in all.
  - 25 were kept as "still on the remote", because the settled rule asks only `glab`.
    Collie's own repository is on GitHub, which keeps merged branches.
  - 1 was kept as "unpushed": a squash merge leaves the branch's commits on no branch.
  - 4 were held by stopped Runs whose work had merged.
  - 24 were never candidates: the previous engine made them, or a human or an agent did.
- **Module generations:** 102,745 staged copies, 8G, in `~/.cache/collie/entries`.
  Nothing removed one.
- **The state directory:** 3.4G.
  - 2.4G is Renovate clones, which are only ever created.
  - About 1G is run directories the previous engine wrote, which ADR-0027 kept on purpose.
  - 278 run directories, 531 agent directories, and every stop and notify marker were kept forever.
- **The test suite:** a `collie-test-<pid>` root per test file, never removed. 377 were
  under `/tmp` and growing.
- **Desktop:** an `ssh` control directory leaked every time Desktop was killed. Staged
  update tars of about 736 MB, a usage log that only grows, and runner copies were never
  pruned.
- **herdr workspaces:** every Task's stayed open until a human closed it, and opened
  focused, taking the human away from whatever they were doing.

## Decision

**D1. Only what Collie made, and can show it made.** Every removal is of one kind
Collie knows, proved the way that kind is proved:

- **Its own directories:** the state directory, `~/.cache/collie`, and Desktop's own data, state
  and temporary directories. These are Collie's by where they are. Inside them, only
  entries of a kind Collie knows are removed; an entry of any other kind is reported and
  left.
- **A worktree:** proved by a Run's record that Collie created it, with the moment git wrote
  it.
- **A workspace:** proved by a Task's record. Never the Home, and never a workspace that
  is no Task's.
- **A pane:** proved by a launch record.
- **A process:** proved by its lock or its control record.

Nothing outside these is globbed. Removal never forces: git's refusal to drop a dirty or
unmerged checkout stays the last guard, so a wrong judgement can fail to clean but never
delete work.

**D2. One sweep, run by the host, shown by `collie cleanup`.** The host sweeps every ten
minutes with no pane open, beside its merge watch and News.

- `collie cleanup` lists what a sweep would remove now, with each item's size and the
  total it frees. It also lists what Collie made and keeps, and why.
- `collie cleanup --apply` sweeps now. Chat reaches the same sweep through its action set.
- Each removal is judged again at the moment it is made, and recorded with its Actor in
  the state directory's `cleanup.jsonl`.
- There is no confirmation step. The host does the same on its own every ten minutes, so
  a confirmation would protect nothing.
- The worktree pruner is one part of this sweep, not a job of its own.

**D3. A Finished Task's workspace closes on its own.** A Task is done with when the board
puts it in **Finished**:

- every Run has ended;
- its work has landed: a Disposition was recorded, its merge request merged, it was a review, or it ended
  with nothing to file;
- nothing is asked;
- nothing is stalled;
- no agent of it is working.

Its workspace is closed once it has been Finished for an hour and, at that moment:

- it is not the workspace herdr has in focus;
- every pane in it is Collie's: the Task's root pane, its Runs' recorded agents, or the
  shell a stop left.

A pane a human opened there keeps the workspace open until the human closes it. Closing the
workspace closes the Task's agents, so a Finished Run can no longer be steered. A
Follow-up Run is the route on ([ADR-0041](0041-a-finished-run-still-takes-steering.md)
D4).

A start opens its Task's workspace without focusing it, as it already opens its tabs.

**D4. A worktree goes after its Task's workspace, once it holds nothing of its own.**
**Settled** is amended:

- Landed is read from the merge watch, which asks GitHub and GitLab both, or from a Disposition.
- A commit counts as pushed when a remote-tracking ref contains it, or when it is the head
  its merged merge request was merged at.
- A stopped Run holds its checkout only until its work lands.
- A checkout Collie made whose branch was switched since is still Collie's, by path and by
  the moment git wrote it. It is judged on what it holds now.

A worktree is removed only once its Task's workspace has closed. These are never removed:

- the plugin root;
- a repository's main checkout;
- a checkout any running host serves from.

A Renovate clone is removed once no kept Run cut a checkout from it.

**D5. What is kept, for how long, and why.**

| What                                                                                                                                                                                        | Kept                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Task and all of its Runs: the rows, the decisions, the engine's journal, its `runs/`, `agents/` and `evidence/` directories, the Runs' markers, ledgers, compaction state and Task record | While the Task is not Finished, its workspace is open, an agent of it is alive, a checkout it made is on disk, or a kept Run points into it. Then for 30 days after its last Run ended. All of it then goes together. | History lists a project's newest 200 settled Runs, which is about 25 days at today's pace, and the conversation keeps 30. Resume, steering, follow-ups and a checkout's proof of ownership need the files while anything above holds. |
| A row the engine has not accepted                                                                                                                                                           | Always                                                                                                                                                                                                                | Recovery hands it over ([ADR-0017](0017-one-request-is-one-run.md) D4)                                                                                                                                                                |
| A state-directory entry no row owns: the previous engine's run directories, rowless stubs, `events.*.log`, `plans/` and `runs/.seq`                                                         | 1 day                                                                                                                                                                                                                 | Nothing reads them ([ADR-0027](0027-one-engine-and-a-hard-cutover.md))                                                                                                                                                                |
| A CLI receipt                                                                                                                                                                               | 30 days                                                                                                                                                                                                               | A retried request id is answered by its receipt, and nobody retries after a month                                                                                                                                                     |
| An upload under `uploads/`                                                                                                                                                                  | 7 days after it was last asked for                                                                                                                                                                                    | A Run given it holds its own copy ([ADR-0046](0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md))                                                                                                                         |
| An agent's compaction state and endpoint                                                                                                                                                    | While herdr lists the agent                                                                                                                                                                                           | This was the rule before, but it only ran when another agent launched. Now it runs every sweep.                                                                                                                                       |
| `cleanup.jsonl`                                                                                                                                                                             | 30 days                                                                                                                                                                                                               | It is the audit of what went                                                                                                                                                                                                          |
| A Renovate clone                                                                                                                                                                            | While a kept Run cut a checkout from it                                                                                                                                                                               | Cloning again is the only cost                                                                                                                                                                                                        |
| A staged module generation                                                                                                                                                                  | 7 days after it was last used                                                                                                                                                                                         | It is named by its content and staged again on a miss                                                                                                                                                                                 |
| A runner copy, on a Machine or in Desktop                                                                                                                                                   | The running one and the newest                                                                                                                                                                                        | Anything older is never run again                                                                                                                                                                                                     |
| A staged Desktop update                                                                                                                                                                     | The running version's tar only, once Desktop has started on it                                                                                                                                                        | It is Electrobun's base for the next delta patch. Without it every update is a full download.                                                                                                                                         |
| Desktop's usage log                                                                                                                                                                         | 30 days                                                                                                                                                                                                               | As for the conversation                                                                                                                                                                                                               |
| Desktop's `ssh` control directories and masters                                                                                                                                             | While the Desktop that made them runs                                                                                                                                                                                 | A dead Desktop's are swept when the next one starts                                                                                                                                                                                   |
| A Desktop chat attachment                                                                                                                                                                   | 30 days after it was last used; a transfer abandoned for a day                                                                                                                                                        | As long as Claude Code keeps the transcripts that name it ([ADR-0046](0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md))                                                                                                 |

A Run's rows go before its files, in one transaction, through the engine's own
`MessageStorage.clearAddress` for its execution. A file left without a row is harmless,
and the next sweep removes it. A row left without its files would bring a Finished card
back as Waiting on you.

**D6. Processes go with what owns them:**

- A Task's agents close with its workspace.
- A compactor endpoint stops once herdr no longer lists its agent.
- A host stops once its lock or its directory is gone, or once the process it watches
  has exited. This was already true. What changes is that every temporary state directory a
  test or a tool makes is now removed, so its host goes too.
- A bridge or `collie mcp` ends when either side hangs up.

**D7. Low disk is something `collie doctor` reports.** It warns when the filesystem
holding the state directory, the cache, the worktrees or the temporary directory has less
than 10% or 5 GiB free, and says what `collie cleanup` would free.

## Consequences

- History reaches 30 days back.
- The previous engine's run directories go: ADR-0027 no longer keeps them.
- A Finished Task's agents can no longer be steered once its workspace closes.
- A Task workspace with a pane a human opened stays until the human closes it.
- The 24 worktrees no Run recorded are never Collie's to remove. A human removes them once.
- The ten-minute sweep replaces the worktree pruner's three minutes. A merged branch's
  checkout now goes an hour or so after its merge, not three minutes after.
