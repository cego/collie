# A human's standing direction outlives the chat

**Status: draft.** Decided by the grill step of run-ecea2b4f. Amends the consequence of
[ADR-0032](0032-a-chat-starts-new-on-the-latest-opus.md) that nothing said in a chat
outlives its process.

## What was true before

As of `cego/collie@4be825d2` (0.115.0):

- **A chat forgets.** Native chat starts a new session on every launch (ADR-0032). The
  Flock chat resumes one warm session, and a new conversation starts empty. Neither loads
  the user's own Claude Code memory: the Flock chat runs with `settingSources: []`.
- **What a chat is told is settled only while it lasts.** The chat prompts tell it that
  what the human said in this conversation is settled, so a Run's question the human
  already answered is answered for them. A standing preference that is not about one launch,
  such as "stage only, production waits for my go" or "Linear team PLAT is for the
  platform repositories", has to be said again in each new conversation.
- **Some standing words already have a home.** A workspace's defaults hold its
  Constraints. The **Machine rule** (`machine_rule`) holds the human's words about which
  Machine work goes to. It is a shared text setting, given to the Flock chat with every
  message, and Collie never interprets it.

Matt Pocock's `chief-of-staff` skill (`mattpocock/skills@5ae48169`,
`skills/in-progress/chief-of-staff/SKILL.md`, MIT) keeps a long-running agent's memory in a
wiki that the agent writes, queries and lints. Most of the rest of the skill is already in
Collie: Schedules (ADR-0052), a daily retro of a day's Runs that files and fixes what they
show (ADR-0053), fresh-context agents that share pointers, not transcripts, and spec, then
tickets, then implement. The wiki is the one thing Collie does not have.

## Decision

**D1. Standing direction is the human's own words, kept for every chat.** It is a shared
text setting, `standing_direction`, in the Chat group beside the Machine rule. Like every
shared setting, its latest edit wins across the Flock (ADR-0043), and it carries the time of
that edit. A setting edit records no Actor (ADR-0039 covers operations, not settings), so who
wrote it rests on D3.

**D2. Every chat is given it with every message, except Native chat on Pi.** The Flock
chat gets it beside the Machine rule, on Claude through its prompt hook and on Pi in its
bracketed note. Native chat on Claude gets it through the context its prompt hook attaches.
Native chat on Pi has no prompt hook, so it gets the text as it stands at launch, in its
launch prompt, and reads the current text from `collie_installation` when asked. An edit made
mid-conversation reaches it only then. It is marked as the human's standing words, with the
date of its last edit.

**D3. Only the human writes it.** It is set in Desktop's or the TUI's Settings, or by a chat
when the human asks for it to be kept or changed. The Flock chat uses its own tool, and
Native chat uses `collie settings set`. A chat that hears what sounds like a standing
preference may offer to keep it, and writes only on the human's yes. Text from a tool, a
Run's notes or an agent's Output never goes into it. An edit from a Run's agent (the `agent`
front door) is refused. AGENTS.md's first invariant allows this one exception, because only an
agent can cause the harm: words an agent read in a repository or a tracker would reach every
later chat as the human's own.

**D4. It has the standing of the human's earlier words, and no more.** A chat treats it as
something the human said earlier in the conversation. It grants no Authority. It is not a
Go and not a Confirmation, so it cannot approve anything that needs the human's say-so on
that thing. It reaches a Run only when a chat puts it there, as it does with any Constraint
the human stated.

**D5. It is bounded.** The setting refuses text longer than 4,000 characters, and says so.
A longer memory is not standing direction.

**D6. Collie drafts it with the human, and the human approves it.** Few people can write
how they like to work from a blank page, and a new user has no Collie history to draw on.
While the setting is empty, Desktop offers to help:

- **When it offers:** once a Machine is connected, so after a fresh onboarding and at the
  first launch after an update. It offers again after each update until the human sets the
  direction or says never. Settings offers it at any time.
- **Where the drafting happens:** in a Flock chat conversation with the human present. No
  Run drafts it.
- **What may be read, and who decides:** the human's own typed messages, and only on the
  human's click in Desktop's own dialog, which first says where they are and how many:
  - each harness's own session store (Claude Code, Codex, Pi, OpenCode), on Desktop's
    computer and on each connected Machine;
  - the words Collie's records hold under a human Actor.

  No model can ask for that text. The reader is in no chat's toolkit, and a host answers it
  only on the `desktop` front door, which the Flock chat's tools do not use. Desktop gives
  what it read to the new conversation as data to draft from, never as instructions.
- **What it never reads:** tool output, model text, context a harness or a hook injected,
  and the sessions Collie started for a Run's agents. In those sessions the user turns are
  Collie's own prompts.
- **When there is too little to read, or the human declines the reading:** the chat asks
  five fixed questions instead. Native chat, with no dialog to take the click, only asks the
  questions.
- **Preferences, not permissions:** the draft says how the human likes to work. An answer
  such as "release to production" becomes what Collie should offer, never an approval in
  advance, since D4 lets the direction approve nothing.
- **Saving:** the chat shows the draft whole and saves it only on the human's yes, through
  D3's path. From then on it is the human's text, as if they had typed it.

## Considered and rejected

- **A wiki the chat writes, as in `chief-of-staff`.** The model would turn its own reading
  of Runs, transcripts and tool output into notes that a later conversation obeys. That
  launders data into instructions, against "only the human's own words are instructions".
  Its claims about how things are would also compete with the Run records, which are the
  account of what happened (ADR-0032). The skill's "write history, not the present" rule
  is how Collie already treats evidence: bound to a revision, append-only, superseded
  rather than rewritten.
- **Turning on the harness's own memory.** It works only on Claude Code, is per directory
  and Machine, can be written by the model on its own, and is not Collie's to show or audit.
- **Folding it into the Machine rule.** Only the Flock chat chooses between Machines, so the
  Machine rule is never given to a Machine. Standing direction is for every chat.
- **A `retrospective` Run that writes the direction from the human's sessions.** The Run's
  Output is data, and no human is present to approve it. Writing the setting would also need
  the agent edit that D3 refuses. The idea of a retro is kept: read what the human actually
  said, then find the patterns in it. That happens in the chat, with the human present.
- **A chat tool that reads the sessions once the chat has asked.** The consent would rest
  on the model asking first. Any turn, or any text that steered it, could call the tool
  without the human's yes.
- **Entries with ids and their own dates.** One text that the human edits is enough. The
  shared setting already records when it was last edited.

## Not taken from `chief-of-staff`

- **"Be relentless; use every user message to improve the environment."** This would put
  unrequested work in every turn, against the rule that work moving a Run's scope waits for
  the human. Environment improvement is `self-improve`'s job, driven by records.
- **Sampling one in five sessions for a retro.** `self-improve` reads every Run of a day.
- **The chat as DRI for a goal.** The human owns goals and priorities (PRODUCT.md). The
  chat acts for them.

## Consequences

- A new conversation knows what the human asked to be kept without being told again.
- A new user gets a first standing direction without writing it from scratch.
- A model's reading of the human's sessions reaches the setting only through the human's
  approval of the whole text.
- Every Machine's chats share one text. Direction for one repository belongs in that
  workspace's defaults, which a chat should suggest instead.
- No text from `chief-of-staff` is copied. The skill is cited as prior art at the revision
  above, so its MIT notice is not needed.

When this lands, CONTEXT.md gains a **Standing direction** entry beside **Machine rule**,
and **Conversation** says what outlives a chat.
