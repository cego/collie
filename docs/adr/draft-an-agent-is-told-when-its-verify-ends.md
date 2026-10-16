# An agent is told when its verify ends

run-33c8f85a.implement's Claude builder ran `collie verify … nuxi typecheck` in the
background twice. Each time it ended its turn with "Waiting for the typecheck" and nothing
woke it, so the Run sat until the two-hour Output budget parked it. The host runs every
`collie verify` and knows which agent asked for it, but it gave the result only to the CLI
process that was waiting on it.

## Decision

**D1. The host tells the agent that asked.** It does so when a `collie verify` that agent
asked for ends, the agent is `idle`, and Collie is still collecting an Output from it. The
host sends a `boundary` Delivery through the Dispatcher with:

- the check's name;
- the result and exit status;
- the commit;
- where the log is.

The host sends nothing to an agent that is working. That agent is either waiting in the
foreground or will hear from its own harness.

**D2. Agents are told they may end a turn on a verify.** The implementer and reviewer
personas, and every step prompt that tells an agent to use `collie verify`, gain one line.
It says that a `collie verify` the agent started in the background is reported to it when
it ends. It also says never to end a turn waiting on any other background job.

**D3. A prompt-only rule was rejected.** Claude Code caps a foreground command at ten
minutes. A rule that verification always runs in the foreground cannot hold for a
15-minute typecheck.

**D4. The idle Output budget is a separate mechanism.** The idle budget is run-ed73efbf's
ticket 03, also in ADR-0062. Neither changes the other:

- The budget is the backstop for any agent that goes idle without its Output.
- This decision removes the commonest reason an agent does so mid-step.

A running verify does not pause the budget. Two idle hours outlast any verify, and the
agent is woken when the verify ends.
