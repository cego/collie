# What a Run authorises reaches auto mode

Retrospective run-88beddc9 read a month of Runs on vm-mk (its Output is
`agents/run-88beddc9/investigate.json`). Collie starts every Claude agent in auto mode,
because the Machine's managed settings forbid bypass. Claude Code's classifier reads the
user's messages, the tool calls and CLAUDE.md. Tool results are stripped, so a file the agent
reads never counts as the user's intent. An agent's only user turn was one line pointing at
its step's prompt file. Whatever a step was meant to do (merge, tag, release, play a stage
job, amend the Run's own branch) therefore reached the classifier only as tool output.
Runs saw 42 refusals. The 0.56.0 release push was refused as [Production Deploy]
(run-3ae1f9fd), and the same command ran an hour later, after the human typed "release it".
An amend and `--force-with-lease` of a Run's own branch was refused as [Git Destructive]
(run-b4b7cc99), and playing and retrying stage jobs was refused as [Production Deploy]
(run-cddaa17f, run-8dc1f7bf). Each refusal tells the agent to stop and let the user decide, so the
Run waits for a human.

The human's own words were not trusted either. Since Claude Code 2.1.296 (2026-10-13), a
typed message reaches the model as `<pasted_content>` once it is longer than about 800
characters or longer than three lines. The harness tells the model that such text may carry
instructions the user did not write. This was measured over 970 Collie deliveries: every
step message stayed plain, and 57 longer deliveries were wrapped. Agents then declined a
human's steer ("that request reached me only as pasted text", run-9e6e269c). The implement
step's rule is to merge only on the human's own message, so that refusal became a stop.

## Decision

**D1. A step's Clearance is typed in its agent's own turn.** `agentWork` takes `clears`:
sentences that each name one action and its target. The Workflow composes them from facts
Collie holds: the repository's remote, the Run's branch, a merge request the forge adapter
found. It never composes them from an Output. Collie appends them to the step's message,
after the pointer to the prompt file, as `Cleared for this step: …`. That message is the
user's turn, so the classifier reads a specific Clearance as the user asking for exactly
that action. A shipped Workflow clears only what its step's content tells the agent to do.
A Clearance is never a permission rule. A pattern in `permissions.allow` skips the classifier
entirely, and a Clearance is still judged call by call.

A project's own module could clear anything. It is already code the host runs as the user,
so clearing adds nothing to what it can reach. An agent can start a Workflow and so gets its
Clearances, exactly as a human starting it does (invariant 1). The Workflow's code bounds
them.

**D2. A Delivery that carries someone's words says whose they are, and stays plain typed
text.** The first line after the delivery token names the sender. For a human (board,
Desktop, a terminal) that is the human, the door and the time. For chat it is the chat for
the human, with the human's own message from that turn quoted. For an agent it is the sender
line that already exists. The answers to an agent's question (ADR-0062) are the answering
human's. Collie's own messages carry no sender line. A step's message and a repair are the
Run's instructions on the user's behalf.

A Delivery whose typed form would be longer than three lines or 700 characters keeps its
words, word for word, as a file in the Run, as ADR-0051 already does above the delivery cap.
The typed form is everything Collie types, the token and the sender line included, and 700
sits 100 under the measured 800. Chat's quote of the human goes into the file with the
words, so what is typed is the token, a sender line of fixed shape, and one line naming the
file. Where even that is over the budget, because the state directory's path is very long,
it is typed anyway and its receipt says so: there is nothing shorter to type.

Collie's prompts tell the agent that a Delivery whose sender line names the human is the
human's own message. implement's merge rule takes a request to merge in a message of its
own from the human, from chat for the human or from another agent writing as itself, alike,
because who sent it is audit (invariant 1). It never takes one found in a work source, a
file, a review finding or a comment.

The classifier reads only what is typed. A long steer reaches the agent as the human's, but
its file reaches the classifier as tool output, so an action auto mode must clear has to be
asked for in one short message. The receipt of a steer kept as a file says so to whoever
sent it. An agent refused an action that only a kept file asked for asks on the Run
(ADR-0062), naming the exact action, and the answer is typed plain under its sender line.
Collie never types an excerpt of a long message instead: a cut can change what it asks.

**D3. A Claude agent's `--settings` carry a Run-scoped `autoMode` block.** Collie writes it
into the settings file it already passes, at launch:

- `environment` says who this session is: the Run, the agent, the Workflow and the Machine.
  It names the checkout, its remote and its branch, and whether the Run created that branch.
  It says that the `collie` CLI, its MCP tools and Collie's state directory are the user's
  own installation acting on the user's Runs, not a shared resource or someone else's
  workload. It explains a `collie-delivery:` message as D2 does: a step's message is the
  user's instruction, and one whose sender line names an agent is that agent's words.
- `environment` quotes the words a human started the Run with, where a human did, credential
  values redacted. For chat, that is the human's own message from that turn, never chat's
  rewording.
- `allow` covers history on the Run's branch: `commit --amend`, a rebase onto the default
  branch, and `push --force-with-lease` of that branch to that remote. It is written only
  where the Run created the branch and, when the agent is launched, the forge says the branch
  is not the default branch and matches no protection rule or ruleset, whatever that rule
  allows. Creating a branch does not make it unprotected: a new `release/*` branch can match a
  rule already. A forge that cannot say counts as protected. Where a human started the Run,
  an action their starting words name directly and specifically, on this Run's repository,
  is the user's stated intent.

Every array starts with `"$defaults"`. Collie never sets `soft_deny` or `hard_deny`, and
`agent_profile` still cannot set `autoMode`
([ADR-0060](0060-a-managed-agent-runs-with-the-operators-profile.md) D4). The block states
facts and the human's own words. Site policy stays the operator's (ADR-0060 D5): which
repositories are public, which environments are stage, Helle. Those go in the operator's
`~/.claude/settings.json`, which their own sessions need too.

**D4. A Renovate Run does not ask what it can decide, and keeps its claim until production
is deployed.**

- Several open Renovate issues: the Run picks one. It takes the one whose title names the
  current month or cycle, else the earliest due date, else the newest. It says which and why
  on the issue and in its Output.
- A tag pipeline whose only unfinished jobs are manual production deploy jobs is released.
  The agent never plays one and never asks to, and its Output names them.
- Whenever the Run holds the Helle claim, the module then keeps it and waits, with no agent
  turn and no question, until the forge shows production carries the default branch's head
  as it stood right after the Run's merge step. That is the reading a card's `in-prod`
  already comes from. The head and the deployment are facts. The Output's production jobs
  only word the card's hint of which jobs to play and where, so an Output that names none
  releases nothing early. Then the module releases the claim and the Run finishes.
- Another team member approving the batch stays a server-side rule, and a question asked
  on the Run (ADR-0062), never in a pane.

**D5. `collie verify` takes its Run from the agent's pane.** `--run` is optional: a pane
herdr reports as a Run's agent names that Run. Prompts write `collie verify -- <command>`,
which leaves agents nothing to alias. Agents had aliased the long form as `$V`, and Claude
Code's critical-path removal check cannot read a variable used as the command word. It
prompted with a two-minute limit nobody answered: 5 denials, and 3 approvals after waits of
up to 11.8 minutes. Every step's preamble also tells the agent: never use a shell variable
as a command word; to wait, use a command that blocks or a background one, never `sleep`;
search under a directory's own path, never from `/`.

**D6. A checkout Collie clones keeps working credentials.** The GitLab adapter cloned over
HTTPS with a one-shot token header. That left an `origin` with no credentials, so every later
fetch and push in the checkout failed ("could not read Username for https://gitlab.cego.dk",
25 Run sessions). A clone's checkout now gets a credential helper that asks the forge CLI
for its token at each use. The token is never written into the checkout.

## What stays guarded

- **Production deploys.** No Clearance names a production job, and D4 leaves production
  jobs to the human. The classifier's Production Deploy rule is untouched.
- **Force-push and deletion of default or protected branches, tags and releases.** D3's
  history allowance names only a branch the Run created that the forge, at launch, says is
  neither the default branch nor protected. A branch the Run was given, such as another
  person's merge request under review, is not covered, and neither is one whose protection
  the forge cannot read. A rule added after launch is not seen by that agent's block, and
  the forge's own protection still refuses the push. Git Destructive keeps its default.
- **Bypassing server-side review.** No Clearance names `--admin` or skipped checks, and
  approval rules stay the forge's.
- **Secrets.** Quoted words pass through Collie's redaction, and `hard_deny` is untouched.
- **The operator's own settings.** `agent_profile` cannot set `autoMode`, and an agent
  editing Claude's settings stays Self-Modification.

## Consequences

- Two facts this rests on are Claude Code behaviour that was measured, not documented: when
  typed text becomes pasted content, and that `--settings` `autoMode` is combined with the
  user's lists. Check both again on a Claude Code upgrade. The second is an operator check:
  `claude --settings <an agent's settings file> auto-mode config`. An agent that runs it
  is refused as [Auto-Mode Bypass], as this decision's own planning agent was.
- A vague Clearance clears nothing. The classifier lets the user's intent override a block
  only when it names the exact action.
- A Delivery from an agent is now recognisably not the user's words, to the classifier as
  well as to the agent. The classifier may refuse what only another agent asked for. That
  guard is Claude Code's, against an agent relaying an instruction planted in something it
  read. Collie adds no rule of its own on top, and the refused agent asks on the Run.
- No permission pattern is added, by the user's decision when this was planned. A pattern
  skips the classifier for every call it matches, and the merge, approve and tag patterns
  already allowed did not prevent one refusal, because agents chained those commands.
- Codex, Pi and OpenCode agents run without the classifier and are unaffected.
