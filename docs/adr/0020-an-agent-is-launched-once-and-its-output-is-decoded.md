# An agent is launched once, and its Output is decoded

**Status: accepted, and proven by a real launch through herdr's own boundary, restarted
mid-flight.** The seam is `src/agents.ts`, the proofs are `test/agents.test.ts`, and the
module an author writes against it is `test/fixtures/native/agent.workflow.ts` — which is
typechecked against the declarations an author is given. [ADR-0019](0019-a-strategy-not-a-field-name.md)
settled what a launch is given; this is what the workflow then does with it.

## Decision

**D1. A workflow asks for the work, not for the steps.** `agentWork` is one call: it builds
the prompt, launches the agent, collects what it wrote, decodes it and hands back a value of
the author's own type. An author who composed the steps themselves would be the one
responsible for not launching twice, and that is not a judgment to distribute.

**D2. Launch and collection are separate Activities, and the repair is a third.** A replayed
collection must never start a second agent, and only a recorded launch makes that true. The
repair being its own Activity is what stops a restart from handing out another one: a
workflow that comes back to an Output already repaired finds the repair recorded.

**D3. Durability does not make a launch exactly once, so it is reconciled.** The agent's
name is derived from the run and the operation, so a launch that may already have happened
is settled by looking: an agent of that name already there is reattached to. A herdr that
cannot say what it has starts nothing and blocks the work with that as the reason. The
prompt goes out through the one sender, so the ledger refuses a second copy of a delivery
already in flight about the same work.

**D4. Uncertainty is reported, never rounded down.** An Output that has not arrived in the
time allowed is `null`, and what the workflow says is that the agent wrote nothing — not
that it did no work. A launch nobody can vouch for fails with the sentence saying so.

**D5. The Output is decoded before any of it is believed.** The author's schema decides,
with every issue reported at once. There is no verdict sniffing and no shape read off the
text: a file that does not decode is unusable however plausible it reads.

**D6. One unusable Output buys one repair, from the agent that wrote it.** It is still in
its pane holding the work, and starting the work again would throw a whole round away over a
write. The repair carries the schema's own issues. A collection after a repair ignores the
text it was given before: the same file again is the agent not having rewritten it.

**D7. The prompt is pure, and what went out is on disk.** `promptFor` builds the ask from
the decoded input and the author's Markdown — no Activity, no host — so a test can read one
without starting anything and a replay never builds a different one. What was actually sent
is written beside the run before it goes, and the Output is the file the prompt named.

**D8. The role is the persona, and the rest is the operator's.** The role is stated rather
than inferred from a workflow's name, and it is injected as a Step's is — a persona file
where the harness takes one, and a prefix where it does not. Harness, model, permissions and
the compaction threshold come from the operator's configuration, through the same
`startArgs` and `installControls` a Step's launch uses.

## What this does not decide

Answering, holding and stopping a native Run belong to ticket 09, and nothing here suspends:
a collection that runs out of time fails visibly rather than parking. Worktrees, cards and
actions are elsewhere. A repair allowance of one is not configurable, and there is no
blanket retry: a second unusable Output is the end of it.

## Consequences

- A workflow says where its agent works. The host knows its own state directory, not which
  checkout a piece of work belongs in, and guessing one would be worse than being told.
- `collie/native` is served from two files. `sdk.ts` is what a module declares about itself
  and must not reach for herdr; `agents.ts` is what it does with an agent and does. An
  author sees one module either way.
- The verified Pi release is 0.86.1. The extension surface Collie generates — the lifecycle
  events, `registerCommand`, `ctx.compact` with its per-request callbacks,
  `ctx.getContextUsage` and `sessionManager.getSessionFile` — is still what Pi 0.86.1's own
  documentation describes, and `--extension` is still the flag; the marker was moved because
  those checks pass, not to quiet a failing test.
