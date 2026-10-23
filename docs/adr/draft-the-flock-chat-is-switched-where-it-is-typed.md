# The Flock chat is switched where it is typed

**Status: accepted, built.**

[ADR-0011](0011-the-conversation-is-a-native-harness.md#amended-2026-10-09-the-flock-chat-runs-on-the-harness-settings-names)
put the Flock chat's harness and model in Settings › Chat. That made switching slow: to
change the model, the human leaves the conversation, opens Settings and types a model name
as the table spells it. On Pi the table lists no models, so the human has to know the name
already. Effort could not be chosen anywhere: claude always ran at medium, and Pi ran at
whatever thinking level it was configured with.

## Decision

**D1. Harness, model and effort are chosen beside the message box, and only there.**
Settings › Chat drops its harness and model rows and gets no effort row. The Settings
screen is already large, and a second place to make the same choice adds nothing. The
choice is one setting, kept for this computer, and not one per conversation. A change made
in either chat window, or by the chat itself, is shown in both windows as soon as it is
saved. `collie_chat_harness` reads and sets the effort along with the harness and model
(invariant 1). Its read also lists what each harness offers.

**D2. Effort is the Flock chat's third setting**, `chatEffort`. It is checked against the
same table as a Run's effort. Left unset, claude runs at medium
([ADR-0032](0032-a-chat-starts-new-on-the-latest-opus.md)). Pi runs at the thinking level
it is configured with for that model, and Desktop passes that level explicitly, so a
resumed conversation does not get back an older override. Choosing another harness unsets
the model and the effort, because both were chosen for the harness before. Choosing another
model unsets an effort that model does not list.

**D3. What is offered is what the harness itself lists.** Desktop reads the list from the
human's own install and login:

- Claude Code: its supported models, with each model's effort levels.
- Pi: its available models, with each model's thinking levels.

Desktop reads the list in a short-lived process. That process loads none of the user's
setup and starts no turn. Every choice is still checked against the shared table and the
Flock's `models.<harness>` extras. The harness's own "default" entry is not offered: an
unset model is named by what Collie runs for it. A model that is not on the list can still
be typed in, and it is checked the same way. A harness that is not on this computer's PATH
is still shown, marked as not installed, and cannot be chosen. A list that cannot be read
falls back to the table.

**D4. A change applies with the next message.** That message may be the human's or one
Desktop sends itself. The turn under way finishes on what it started on. A new model or
effort resumes the same conversation. A new harness starts a new conversation on that
harness. Until then, the conversation on screen stays, and the window says that the next
message starts a new conversation on that harness. Before this, a harness chosen in Settings
replaced the conversation as soon as the turn ended, so the reply the human was reading
disappeared. While a turn is running, the window also says which choice the current reply
finishes on and which choice the next message runs on. Desktop's main process reports what
the live session runs on, so a turn Desktop starts itself (and, later, a Fallback) is
reported the same way.

**D5. A harness switch asks nothing; it can be undone instead.** Until the next message,
the notice of a new harness offers to stay on the conversation's own harness. That puts back
the harness, model and effort that were set before the switch. Earlier conversations lists
the history of every harness the chat can run on, newest first, with each entry marked by
its harness. Reopening a conversation held on another harness moves the chat to that
harness, and so unsets the model and the effort. Before this, the list showed only the
current harness's history, so going back to a conversation took two steps. A confirmation
would protect nothing that cannot be undone, so it would be ceremony.

## Consequences

The first time Desktop shows a harness's choices after it starts, it starts that harness
once to read its list. This costs a process start and no tokens. The list is kept until
Desktop quits, so a model added to a login appears after a restart. Each list belongs to
the human's own login, so an organization that narrows its models narrows what is offered.

Settings › Chat keeps the Machine rule and **Flock chat speaks first**, and no longer names
the chat's harness or model. This supersedes the part of ADR-0011's harness amendment that
put them there.

Pi lists thinking levels only for its current model, so Desktop selects each model in
turn. Pi 1.1.0 was checked on 2026-10-22 against a copy of its configuration. Selecting a
model in a process that keeps no session leaves Pi's `settings.json` unchanged. Started
offline, Pi also skips its package check. The levels differ by model: some models have no
`max` level, and some have no `off` level. Offering every level for every model would
therefore offer levels the model does not take. Pi answers RPC commands out of order, so
the reader waits for each answer before it sends the next command.
