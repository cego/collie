# Collie steers through the Driver

**Status: proposed.** The design is implemented and tested; what is outstanding is the
live evidence it depends on — see Consequences.

A human sets goals, constraints and delegated authority per Run; sees what every Run is
doing and what backs that up; talks to Collie about it; and lets Collie correct drift
within explicit per-Run authority. Every part of that goes through the Driver that already
owns the Run. No daemon, no socket server, no database: [ADR-0004](0004-coordinate-runs-through-the-filesystem.md)
stands unchanged, and the inbox is still the only way another process changes a Run.

## What was true before

- **The Driver read its inbox only at a Choice.** A command written while an agent worked
  sat unread until the next question, which for most of a Run is never.
- **Six places sent text to an agent**, none aware of the others: the next step's prompt, a
  repair, a nudge, two hand-offs and a compaction request. A hand-off from the board and a
  nudge from a Driver could land in one pane in either order.
- **herdr has no accepted-prompt signal.** It types text into a pane and returns. Nothing
  in that says the harness took it as a turn, understood it, or stopped what it was doing.
- **A Run recorded inputs and Outputs but no goal**, so there was nothing to compare work
  against, and nothing an agent said about its tests was distinguishable from a result.

## Decision

**The Driver is the only actor over agents.** Drift checks run at its own loop points —
`collect`, work boundary, `awaitAgent` poll, `finish` — and no process sends to an agent
without a Driver claim on its Run. Everything else writes files and waits.

**One Dispatcher sends.** `dispatcher.ts` holds an agent's ledger lock across the
compaction decision, the composition of anything steering has queued, and the send. The
reservation is written **before** herdr is called: a crash then leaves evidence rather than
silence, and a later reader settles it `unknown` — the state that asks a human — rather
than guessing in either direction. What blocks a repeat is the _causal key_, the work, not
the words.

**Submitted, acknowledged and verified are separate facts.** herdr taking the text is not
the agent reading it, and neither is the work being right. A system that collapsed them
would report work as done on the strength of a send.

**Capabilities are recorded live and fail closed.** `now` and `interrupt` need a passing
result in `CAPABILITIES.md` for that harness; `boundary` needs none, because it is the next
prompt file. An interrupt reports `interrupt_requested` and `interrupt_acknowledged` and
never "stopped": no proof of quiescence exists at this boundary.

**The evaluator is a tool-less subprocess.** Collie holds no API key and grows no MCP
server. One harness CLI run with `--tools ""`, no inherited settings, a clock and an
output cap, answering only in closed schemas — there is no action in the union that is
"run this string". The argv is asserted word for word in a test, because it is the whole
of the isolation. No spending cap is among the flags and no call-count quota gates a
call: the maintainer's decision is that model-call usage is recorded — per call, per Run,
per Herd, with what the CLI said it cost — and never used to block or throttle work.

**Proposals are durable and confirmation is exact.** A confirmation names the proposal and
its content hash: a yes to a summary is not consent to a payload nobody read. Who counts as
human is derived by the front door — a controlling terminal, or a keypress on the board —
so a Driver, the election winner and the evaluator cannot confirm, including the
evaluator's own suggestion. There is no `--yes`.

**A verification is independently collected and snapshot-bound.** `collie verify` watches a
command's exit and fingerprints the tree before and after; a result whose snapshots differ
is `unstable` and never `pass`. An agent's Output about tests is a **claim**, shown as one.

**Rules and judgement are apart.** A `rule` constraint is a fact Collie checks itself and
never pays a model for. A `semantic` one is judged against bounded actual evidence — a
capped diff of the files it names, with truncation recorded. Nothing passes on an absence:
a verification nobody ran is a breach, and a judgement nobody could make is `skipped` with
its reason.

## Relation to ADR-0004

Consistent with it, and deliberately so. Everything added here is a file under the state
directory read and written under the same pid-lock discipline: intents, ledgers, proposals,
the conversation, cards, elections. The Driver remains the only writer of its own Run's
authoritative state, and the inbox remains the only way in.

What _would_ require amending ADR-0004: a resident process that outlived a Run, a socket
anything but herdr's own, or a store that is not files. None of those is here.

## Alternatives rejected

- **A resident steering service.** It is the daemon ADR-0004 exists to avoid, and the
  Driver already has exactly the lifecycle the work needs.
- **A supervisor per board.** The board is a view; giving it authority over agents would
  make closing a window a change in behaviour.
- **A natural-language grammar of Collie's own.** A brittle second language between the
  human and the operations they already have. Deterministic verbs plus one evaluator that
  can only propose is strictly less to be wrong about.
- **Direct sends when no Driver is live.** Text in a pane with nothing to compose it into
  the agent's next work, nothing to hold it behind a compaction, and nothing to record
  whether it was understood. Replaced by a follow-up child Run.
- **Pane text as authority or attribution.** A transcript is not a signal; a hook is.
- **Substring-of-a-steer as consent.** A steer is a question. Consent is a separate act
  naming a specific thing.

## Consequences

New modules: `intent.ts`, `steering.ts`, `dispatcher.ts`, `steering-caps.ts`, `evaluator.ts`,
`proposals.ts`, `executors.ts`, `conversation.ts`, `drift.ts`, `verify.ts`, `cards.ts`,
`home.ts`, `live.ts` and `ui/live.tsx` — the last two being what the board is given and how
it draws it. One new socket method, `agent.send_keys`, with a contract-test row. Persona and
workflow text now route test runs through the collector and ask for progress checkpoints.

**What has not been proved.** The capability table ships entirely `unproven` and the
evaluator's live probe has not been run: both need paid calls or live agents and an
operator present. Until they are, `now` and `interrupt` fail closed and `boundary` is what
works — which is the honest state, not a gap being papered over. The Run's `CAPABILITIES.md`
records exactly which rows are `not-run`, and the acceptance gate refuses while they are.
