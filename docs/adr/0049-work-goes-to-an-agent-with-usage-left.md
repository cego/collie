# Work goes to an agent with usage left

**Status: accepted, to be built.**

Each Machine's host reads how much of the human's Claude and ChatGPT subscriptions is
left. Desktop, the CLI, chat and workflows all see that one reading. When the agent a
piece of work would run on draws on a subscription that has run out, the work moves to
the next agent in the human's fallback chain, before it starts or while it runs. Usage
decides where work runs, never whether it runs.

## What was true before

Every shipped workflow runs on `claude`/`opus`. When a Claude subscription reaches its
session or weekly limit, Claude Code stops the turn and waits for the reset, then
continues by itself. Codex stops. Collie cannot tell either case from an agent that is
still thinking. It waits for the Output for up to two hours, then parks the Run, saying
nothing about why. Collie records model-call usage as data and never uses it as a quota
(ADR-0010, Authority). Nothing reads how much of a subscription is left, and Desktop
shows none of it.

## Decision

**D1. A Subscription's usage is read on its Machine, by its host.** The logins are the
Machine's own, so each host reads the subscriptions its harnesses are logged in to.

- **Claude**: `GET /api/oauth/usage`, the endpoint Claude Code's `/usage` reads, called
  with the login Claude Code keeps on that Machine. On Linux that login is
  `~/.claude/.credentials.json`; on macOS it is the Keychain item `Claude
  Code-credentials`. Collie reads the login and never refreshes it. A refresh rotates the
  token and signs Claude Code out, so a login that has expired gives a reading that says
  so. Rows are classified by their `limits[].kind`, never by their label.
- **ChatGPT**: `codex app-server`'s own `account/rateLimits/read`. Collie asks a running
  Codex agent's server where it has one, and starts one over stdio where it has none.
  Collie never handles a token for it. Windows are classified by their length, because
  `primary` is the weekly window on some plans.
- **Claude agents Collie starts**: Collie already gives each one a status line. That
  status line's `rate_limits` is documented, and it changes after every response. It
  feeds the same reading, and the newest sample wins.

Omarchy reads the same two endpoints, the same way. Local token logs are not a source.
They count tokens, and a subscription's limit is not published in tokens.

**D2. A reading says how fresh it is.** It carries when it was read, where it came from,
and why it is missing where it is. A host calls each endpoint at most once every five
minutes. After a refusal it waits as long as the endpoint asks, and keeps the last
reading with its age. Claude's endpoint refuses callers that ask more often; Omarchy
settled on fifteen minutes. Between calls, the status lines of running agents keep the
reading current. Every door asks the host and never calls a source itself. A window whose
reset time has passed is no longer counted, whatever the reading says.

**D3. One reading answers every door.** Desktop gets it through a front-door operation.
The operation is additive, so `PROTOCOL` stays. The CLI shows it with `collie usage`,
chat runs that command, a workflow reads it from its `Host`, and the choice of agent uses
it.

**D4. Usage chooses where work runs, never whether it runs.** No reading refuses, holds or
delays work. A subscription is **Exhausted** when one of its windows that applies to the
model is used up and the reset is still ahead. Used up means fully used, or reported as
reached by its source; a team plan's spend limit is reported that way. A choice that draws on an Exhausted
subscription moves to the next agent that has room. If every agent is Exhausted, the work
starts on the agent it preferred, as before, and the Run's record says why. A
subscription Collie cannot read counts as having room.

**D5. The fallback chain is the human's setting.** `fallbacks` is a list of `harness` or
`harness/model` entries, such as `codex, pi/openai-codex/gpt-5.6-sol`. It is shared across
the Flock like every setting (ADR-0043). It comes after whatever the work itself prefers.
It is empty by default, which keeps today's behaviour. It does not live in a workflow's
definition: a definition says what the work wants, and the chain says what the human pays
for. Collie ships no named presets. A list of harness names is already a preset, and
`default` follows each harness's own default model. A named preset would hide which
models it means, and it would go stale as models change.

**D6. A choice draws on the subscription its provider is.** `claude` draws on Claude and
`codex` on ChatGPT. `pi` and `opencode` draw on whichever provider their model names:
`anthropic/…` on Claude and `openai-codex/…` on ChatGPT. Any other provider draws on
nothing Collie reads. So a chain entry that only reaches the same subscription through
another harness is skipped once that subscription is Exhausted.

**D7. A fallback happens before the agent starts if Collie can tell.** The work's
`.agent` Activity folds preferences as ADR-0030 says. Then it takes the first candidate
that has room. The candidates are the folded choice, then the choices the work names
beyond it, then the chain. Collie records the chosen agent before anything starts, with
the choice it fell back from and why.

**D8. An agent that runs out mid-work is stopped, and a new agent takes over its work.**
An agent has run out when the subscription it draws on reads Exhausted, or when its
harness reports that it stopped on its limit. If its Output is not yet written, Collie
closes it, because Claude would otherwise go on in the same checkout at the reset. Then
Collie starts a new agent on the next candidate with room. The new agent gets the same
operation, the same prompt, and a hand-over that says three things:

- the checkout holds what was done so far;
- the earlier agent's transcript is at this path, where its harness reported one;
- the Output is still to be written.

The new agent also takes the old agent's place for later work that names it. A
conversation still cannot change harness (ADR-0030); the new agent is a new
conversation. Each switch is its own Activity, so a replay never starts a third agent.
Waiting for the reset is not offered while another agent has room. Waiting keeps the
context, but it holds the Run for up to a week.

**D9. Only running out moves work.** These do not move it:

- **A transient rate limit or overload.** The harness retries it, and the window is not
  spent.
- **A harness that will not start, is signed out, or crashes.** The Run parks with its
  reason, as before. Moving the work would hide a broken installation on every Run.
- **Predicted exhaustion.** It moves work only as a ceiling that the work or its workflow
  asks for (D10).

**D10. A workflow can set a ceiling, and the default is to use a subscription to the
end.** An agent preference may say `upTo`, a percentage. It is the share of the busiest
window at which that agent stops being chosen for new work. A preference may also say
`otherwise`: the choices to try past that point, before the chain. For example, use xhigh
effort up to 80%, then medium. A workflow that wants anything else reads the usage from
its `Host` inside an Activity of its own. The default sets no ceiling. A ceiling spends a
weaker agent on every Run while the preferred one still has usage, and a reset gives that
usage back anyway.

**D11. Every agent says what it ran on.** The Run's record shows each operation's agent
as harness, model and effort. A fallback also shows what it fell back from and why, in
Desktop's record and in `collie run show`. The Run's log gets a line when the fallback
happens.

## Consequences

- With `fallbacks` set, a Run that hits Claude's limit carries on with Codex. The
  operation it was in starts again in a new agent. That agent works from the checkout,
  not from a conversation.
- A Run that falls back mid-work loses that agent's conversation. A plan's interview
  survives only in the transcript the new agent is pointed to.
- Machines logged in to one account share its Subscription, and each reads it for itself.
  Usage another Machine spent shows up at this Machine's next read, at most five minutes
  later. An agent started in that gap runs out on its first request and falls back mid-work
  (D8). Collie does not relay readings between Machines. Every Machine on an account calls
  the endpoint, so a refusal is more likely, and D2's back-off absorbs it. Desktop shows
  one entry per account, keyed by the account's id and not its email.
- Some fallbacks only help when a harness fails. pi on `openai-codex` draws on the same
  ChatGPT subscription as Codex. For usage, a fallback needs another subscription.
- The Claude endpoint is not documented. If it changes, the reading says it cannot be
  read, and work treats Claude as having room. The status-line samples from running
  agents still decide while one runs.
- Model-call usage stays telemetry (Authority). This reading is about the human's
  subscriptions, and it chooses an agent. It never refuses work.

## Amended 2026-10-09: the Flock chat falls back too

**Status: accepted, to be built.**

The Flock chat runs on the harness and model Desktop's Settings name
([ADR-0011](0011-the-conversation-is-a-native-harness.md), "Amended 2026-10-09"). A
conversation on a Subscription that has run out stopped there, though the human pays for
another. It now moves as work does, on the same judgement.

- **Its chain is its own.** `chatFallbacks` is under **Chat** in Desktop's Settings, for
  **This computer only**, because the chat runs on this computer's logins: `harness` or
  `harness/model` entries in order, empty by default. Each entry is checked as a `fallbacks`
  entry is, and names one of the harnesses the chat runs on. The Runs' `fallbacks` is not
  read for it.
- **The candidates and the room are the Runs'.** The chosen harness and model come first,
  then the chain, resolved and judged by the same functions a Run's agent is (D5–D7). The
  reading is this computer's Machine's, asked of its host as every door asks (D2, D3).
  Where this computer is not a Machine, nothing reads its Subscriptions, so it counts as
  having room, and only the harness's own report of a limit moves the chat.
- **It is judged before each message, and when a turn stops on its limit.** A conversation
  whose own choice has room stays where it is. One whose choice has none moves to the
  first candidate that has room, from the top of the list. A turn the harness ends because
  the Subscription is used up is given again to the next candidate with room. That is
  never done for a transient rate limit, an overload or a harness that will not start (D9).
  A new conversation starts on the first candidate with room.
- **A move keeps the conversation where the harness is the same.** A move to another model
  of the same harness continues it on that model. A move to another harness starts a new
  conversation on it. Its first message carries Desktop's hand-over beside the human's
  words: where it moved from and why, and the earlier transcript's path where its harness
  keeps one as a file. The earlier conversation stays in its own harness's history.
- **The chat says what it moved to.** A turn that runs on a different choice than the turn
  before opens with a line of Desktop's own: from what, to what and why. Where nothing has
  room, the turn runs on the conversation's own choice, and the line says so (D4). A move
  never refuses or holds a message.
