# A ticket is built by an agent of its own

**Status: proposed.** The matched trial's first stage (2026-11-23 to 24) qualified no arm,
so `agent_sessions` stays `run` and `inline_plan` stays `off`; see Consequences. Amends
[ADR-0024](0024-a-list-of-work-is-known-by-its-names.md) D5,
[ADR-0007](0007-compact-a-reused-agent-at-a-work-boundary.md) and
[ADR-0049](0049-work-goes-to-an-agent-with-usage-left.md) D8.

## What was true before

An implement Run built every ticket, every review-fix round and the merge request on one
agent, `build` (ADR-0024 D5). Its context grew with each ticket, and compaction between
pieces of work (ADR-0007) only trimmed it. A quota Fallback was the one place another agent
took the work over, given three lines of hand-over.

## Decision

**D1. A Run's work and its agents are separate, and `agent_sessions` says which agent runs
what.** The Run keeps its checkout, branch, journal, findings, plan and Outputs; agents
are replaceable, and each name is derived from the Run and the work, never from a position.

- `run`, the default, keeps one builder, `build`, for everything.
- `ticket` builds the first ticket (and any planning before it) on `build`, and each later
  ticket's build, criteria hand-backs and review-fix rounds on `build-<ticket>`. The final
  review's fix rounds, the last fix, the gate fix, the merge request and the CI fix run on
  `deliver`. Work that never left `build`, such as one ticket, keeps it to the end.
- `round` is `ticket`, plus a fresh fixer for each review-fix round: `fix-<ticket>-<n>`, and
  `fix-final-<n>` for the final review's. `deliver` takes the gate fix onward.

**D2. A boundary ends the outgoing agent and finds it Quiet before the next one starts.**
The outgoing agent is ended through the end path a Fallback uses. A predecessor that is not
Quiet parks the Run on `predecessor-not-quiet`, which its recheck clears and no Heal takes,
and nothing starts until it is. One writer works in the checkout at a time.

**D3. The default is measured, not assumed.** `ticket` and `round` exist so the trial can
compare them against `run` on the same plans. Until it does, `run` is the default and this
ADR stays proposed.

**D4. The hand-over is one revisioned record the host builds** (ADR-0049's amendment of
2026-11-20, **Hand-over** in `CONTEXT.md`). It goes out in the new agent's first delivery,
once per new agent, at every boundary and every Fallback. One whose head, plan revision or
uncommitted work no longer matches the checkout is rebuilt once, then parks on
`hand-over-stale`. A fixer's names the head its findings were reviewed at.

**D5. Nothing new starts where nothing changed.** A wait, a duplicate delivery, a restart,
a crash replay, an Output reminder or repair, and an answer to a pending question go to the
agent that owns the work. A replay resumes the same step on the same agent name, and a
boundary already crossed is not crossed again.

**D6. The value is fixed on the Run when it starts.** It is recorded with the Run's other
features, so a changed setting never splits a Run, and a Run with no record keeps one
agent. The board shows each builder as a tab of its own; the ended ones stay listed, the
live one is marked, and Go to pane opens it.

## Consequences

Each ticket starts with an empty context and the hand-over instead of the transcripts of
the tickets before it. The price is a launch and a Quiet check per boundary, and what the
outgoing agent knew but did not write down. The build prompt therefore asks for its
decisions, rejected approaches and next action under `ticket` and `round`.

### The matched trial: stage 1

Twelve implement Runs of build 150c5346 ran against the test fake GitLab. Every session was
Claude, Opus, high, and the shipped reviewer, with the same settings, audited each Run's
merge request. Every Run's Checks were `static` and one `bun test` of its case's files,
identical within a case. Case C restarted its host once, on ticket 8's build delivery,
named by its delivery id in `trial/logs/restart-<cell>.json`. That delivery's event is its
first `submitted` row in its host's delivery ledger: seq 182 for c-run-off-1, 416 for
c-ticket-on-1 and 5 for c-round-on-1, each written before its restart was requested
(`trial/logs/delivery-seqs.txt`). The seq the operator recorded at the time, 730, 8096
and 669, was a board change, not that event. `tools/trial-restart.ts` now records the
ledger's seq, and the board stream only wakes it. c-ticket-on-1's `collie host restart` answered
with the old pid, because that host took 5 s to stop. Its log shows the restart: pid
853294 stopped at 01:48:31Z and 3927688 started at 01:48:36Z. The tool now confirms a
restart only once the host lock has a new owner. The records are in the
implement Run's `trial/` directory: `runs.tsv`, `interventions.md`, `reports/records.md`,
`reports/figures.md`, and the reports themselves.

| Case | Cell          | Accepted     | Escaped defects | Interventions | Sessions | Total tokens | Delivery tokens |
| ---- | ------------- | ------------ | --------------- | ------------- | -------- | ------------ | --------------- |
| A    | `run`/`off`   | 1            | 2               | 1             | 6        | 102,186,588  | 32,263,086      |
| A    | `ticket`/`on` | 1            | 1               | 0             | 6        | 91,703,304   | 26,233,989      |
| A    | `round`/`on`  | 1            | 3               | 0             | 7        | 96,687,728   | 16,738,020      |
| B    | `run`/`off`   | 1            | 0               | 0             | 4        | 16,512,367   | 10,854,232      |
| B    | `run`/`on`    | 1            | 2               | 0             | 2        | 12,585,126   | 730,125         |
| C    | `run`/`off`   | 1            | 0               | 2             | 5        | 115,714,933  | 12,801,367      |
| C    | `ticket`/`on` | 1            | 1               | 4             | 10       | 125,132,455  | 26,084,776      |
| C    | `round`/`on`  | 1            | 2               | 0             | 7        | 96,002,533   | 20,718,198      |
| D    | `run`/`off`   | 1            | 1               | 1             | 4        | 86,149,738   | 26,258,352      |
| D    | `run`/`on`    | 1            | 2               | 0             | 3        | 112,874,778  | 30,948,054      |
| D    | `ticket`/`on` | not compared |                 |               |          | 118,201,570  | 27,210,235      |
| D    | `round`/`on`  | not compared |                 |               |          | 138,687,026  | 24,678,727      |

How the table was measured:

- Total tokens are input, output (reasoning included), cache reads and cache creation.
- Delivery tokens are the steps after the last ticket: the final review's rounds and fixes,
  the gate fixes and `mr`. B `run`/`on` reviewed inside its build step, so its delivery
  figure is small.
- Checks passed in every compared Run, and no reopened finding was raised.
- The planted regression was caught in every C Run, the baseline included: no repeat let it
  escape. plantedCaught is read from the final tree (`trial/planted.sh`): the Run's own
  ticket 7 `run list --status parked` test, run through `collie verify` on its own host. That
  test cannot pass while the plant drops parked Runs from `run list`. A builder that fixes
  the plant before review has caught it, since the measure asks whether the defect escapes,
  not who stopped it. Whether a review named it is reported apart and given no direction:
  none did, because every C builder had already fixed it while building.
- Follow-up: ticket 24's plantedCaught counts only review findings at the plant ([cego/collie#526](https://github.com/cego/collie/pull/526)), and
  so misreads a builder's fix. Ticket 26 keeps the same plant and this reading.

**The rule's result.** Each escaped-defect figure is a single audit of a single Run, so a
failure here means one repeat did not show the arm no worse, not that the arm is worse.

- `inline_plan`: one repeat did not show `run`/`on` no worse than `run`/`off` on escaped
  defects in B or D, and it was cheaper only in B. It does not qualify, so `inline_plan`
  stays `off`.
- `agent_sessions`, compared against `run`/`off` on A and C, since `inline_plan` stays
  `off`:
  - `ticket`/`on`: one repeat did not show it no worse on escaped defects and interventions
    in C, and it was cheaper only in A.
  - `round`/`on` was cheaper in both cases: 96.7M tokens against 102.2M in A, 96.0M against
    115.7M in C. One repeat did not show it no worse on escaped defects in either (A 3
    against 2, C 2 against 0). A broader trial could take it up from here.
- Neither qualifies, so `agent_sessions` stays `run`.
- Every arm failed stage 1, so stage 2 did not run and no default flipped.

**How the figures were read.**

- From the switch on, each Run had a host and state directory of its own. The reason is
  that a host's request ids are not scoped to a Run ([cego/collie#541](https://github.com/cego/collie/issues/541)).
  Two `run`/`on` D Runs had been handed another Run's merge request and were excluded.
  - The shared `trial/state`: every `run`/`off` cell, B `run`/`on`, A and C `ticket`/`on`.
  - `trial/states/<name>`: D `run`/`on` (d-run-on-1b), D `ticket`/`on` and every `round`
    cell.
- The reports were therefore made by `trial/compare.ts`, not by
  `collie run metrics --compare`. It reads each Run over its own host. On the six kept Runs
  of the shared host, its output was byte-equal to `--compare`'s
  (`trial-compare-equal`, evidence `verify/2026-11-24T07-06-48-566Z-trial-compare-equal.log`).
  Both are registered on the implement Run.
- The host's fake-forge URL reached the Runs' own `tests` Check, so Checks were judged after
  each Run ended:
  - The command is `trial/postcheck.sh`, which is `env -u COLLIE_FORGE_API bun test` with the
    case's files. It ran on each final tree, on the Run's own host.
  - A Run's Checks passed when they added no failure over 657bed18's list. Any other failure
    got one rerun with `--again`, at idle, and both attempts are kept
    (`trial/logs/postcheck-<cell>.txt` and `-again.txt`). Only c-round-on-1 needed it, and its
    rerun failed only the listed test.
  - The base's list is one test, verify-told's "a settled agent being collected from is told
    its verify ended". It failed in both recorded runs of `guard-check-output` on 2026-11-17,
    and passed in `base-657bed18-tests-acd` and `-b`.
  - The Runs' own Check records are kept as the evidence of the leak.
- Other confounds, matched or recorded in `trial/interventions.md`:
  - The origins refused push options until 2026-11-24T01:47Z.
  - The operator's quota ran out on 2026-11-23, at about 13:00.
  - Interventions were the same policy in every arm. They were one resume per park, and
    leaving host-started Heals alone.
