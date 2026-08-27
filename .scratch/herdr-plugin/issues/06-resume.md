# 06: Resume a run

**What to build:** `resume` action lists runs with unfinished steps; picking one skips steps with recorded Output and restarts the rest with fresh agents; toast on completion.

**Blocked by:** 05

**Status:** done

- [x] finished steps skipped (tested)
- [x] unfinished steps restart fresh, never reattach

**Notes:** The engine never reattaches, and it needed no resume flag to get there:
a Step's recorded panes and agents are only reused when that Step has already run in
*this* process. That covers both cases with one rule — a loop-back reuses (or, with
`fresh`, replaces) the pane it just made, while a resumed Run starts fresh agents for
every unfinished Step.

`agent: <step>` is the same rule: it borrows an earlier Step's agent only if this
process started it. So on resume, `fix` and `commit` start their own implementer
instead of prompting a dead agent.

The sidebar filter is built from panes this process created, and disputed findings are
deduplicated on collection so a re-run Step cannot report the same one twice.

**Live check:** the `resume` picker listed the interrupted run with its status, the
steps still left and when it started.
