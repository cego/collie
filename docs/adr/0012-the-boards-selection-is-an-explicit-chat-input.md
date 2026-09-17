# The board's selection is an explicit chat input

**Status: accepted, D2 amended.** Built with the Control Plane redesign: the board
writes its selection to the Herd's own directory, the Home's Claude Code is told it with
each prompt through a per-launch `UserPromptSubmit` hook (`collie chat context`), every
run-scoped tool accepts it when given no Run, and `setup.sh` offers it under the chat
prompt as Claude Code's status line.

The board's current selection is a **fact chat may read**, and it is never a filter
Collie applies on chat's behalf.

## What was true before

The Home has two halves and one rule between them: the reads are Herd-wide and are
**never narrowed** by the board's filter or by which row is selected
([ADR-0011](0011-the-conversation-is-a-native-harness.md) set the reach;
[ADR-0009](0009-the-collie-tab-is-the-herds.md) set the board). `collie_herd`'s own
description says so.

That rule was right about the danger and wrong about the cost. A model told about forty
of a hundred Runs, without being told so, answers "that is all of them" in good faith;
narrowing a read by what a pane happens to be showing is exactly how that happens. But the
human sitting in front of the Home does not talk in Run ids. They select a card and ask
"how is it going?", and chat had no way at all to know what "it" was — so it either asked
them to repeat what was on screen in front of them, or guessed. Both are the interface
obstructing the person it serves, which is the thing
[ADR-0011's amendment](0011-the-conversation-is-a-native-harness.md) named.

## Decision

**D1. The board writes what it has open.** One small file per Herd,
`herd/<key>/selection.json`, holding the Task's id, the Run its card acts on, and the name
the human can see. Written whenever the record on screen changes, and removed both when
that record closes and when the board does, so what it says is true right now or absent.
It is the board's own state, not a Run's: nothing in a run directory changes because a
human clicked on a card.

**D2. It is attached to the prompt, not fetched by a tool.** _Amended._ The first cut
gave chat a `collie_board_selection` tool, and the cost showed at once: every "stop it"
was two round trips — look the card up, then act — and a model that skipped the lookup
asked the human to repeat what was on screen. Now the Home's Claude Code is launched with
an additional settings file (`--settings`, never the human's own) holding one
`UserPromptSubmit` hook, `collie chat context`. It prints one line naming the open card,
or nothing while none is open. Attached when the human **sends a message**, never when
they click: a card opened and never asked about costs the conversation nothing, and a
closed record stops the line. The lookup tool is gone. Pi has no such hook; there the
run-scoped tools given no Run are the route.

**D3. A run-scoped tool may take the selection when nothing was named, and says that it
did.** `collie_run`, `collie_receipts`, `collie_hold` and `collie_do`'s run-scoped actions
take `run` as before. Given none, they act on the selection and open with which Run that
was. The sentence is the
whole safety of it: an answer about work nobody named that does not say which work is how
"how is it going?" gets answered confidently about the wrong thing.

**D4. The Herd-wide reads stay Herd-wide.** `collie_herd`, `collie_workspaces`,
`collie_news`, `collie_definitions` and `collie_installation` are unchanged and unnarrowed.
This ADR **revises** the earlier wording — "the reads are never narrowed by the board's
filter or its selection" — to: reads are never narrowed _implicitly_; the selection is an
input a tool may be given, and a tool that takes it says so.

**D5. The human sees the same fact.** Claude Code's `statusLine` prints
`board selection: <name>`, or `board selection: none · whole herd`. It is configured by
`setup.sh` in the human's own Claude Code settings — first-time work they run on purpose,
like the keybindings, and never `prepare.sh`'s — and `collie doctor` reports whether it is
there. A status line somebody else configured is named and left alone, and outside a Herd
the command prints nothing rather than a line about a board that is nowhere near.

## Alternatives rejected

**Narrowing the reads by the selection.** The failure it causes is silent and the answer
is confident, which is the worst pair. `collie_herd` exists to be the whole flock.

**Pushing the selection into the conversation on every click.** A custom message per
click would spend context on mouse movement and interrupt turns with something nobody asked
about. The news channel is for developments, not for where the pointer is. The prompt hook
is the opposite shape: it fires on the human's message, so it costs one line exactly when
they speak.

**Keeping the selection in the Home record.** `home.json` is about ownership — which
workspace is the Home and what proves it — and is written under a lock. What a pane is
showing changes many times a minute and must never contend with that.

**Passing its value through the launch.** A conversation is launched once and lives for
hours; the selection changes constantly. A launch flag would be stale before the first
question. What the launch carries is the hook that reads it, which is never stale.

## Consequences

Chat can answer "how is it going?" about the card in front of the human, and says which
Run it answered about, so a wrong selection is visible in the answer rather than hidden
in it.

The status line is a setting in the human's own Claude Code, so it applies to every
session they open. That is why it is `setup.sh`'s step and why the command prints nothing
where there is no Herd — and why an existing status line of theirs is reported rather than
replaced.

A board running outside herdr has no Herd to write to, and writes nothing. Chat there
reads "nothing selected", which is true.

A board that is killed rather than quit leaves its last selection behind, until the next
board opens and clears it. Chat can be told about a card nobody has on screen for exactly
that long; the alternative is a lock or a heartbeat on a file whose whole value is being
cheap enough to write on every click.
