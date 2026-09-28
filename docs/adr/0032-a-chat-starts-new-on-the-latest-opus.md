# A chat starts a new conversation, and claude's is on the latest Opus

[ADR-0011](0011-the-conversation-is-a-native-harness.md) bound the chat to one session
per Herd and harness, resumed on every relaunch, and pinned no model. Resuming carried
the whole history into every turn of a conversation that lasts as long as the Herd, and
Claude resumes on the model a session began with: a chat begun on Opus 5 was still on it
long after Opus 5.5 was available.

## Decision

A chat that has to be launched starts a new conversation, whichever session was
recorded; one still running is adopted as before. The claude chat is launched with
`--model opus --effort medium`: the alias, not a version, so every launch is on Claude
Code's latest Opus. pi's chat keeps its own model.

## Consequences

Nothing said in a chat outlives its process: what matters is on the board and in each
Run's record, which a new conversation reads. A model or effort chosen inside the chat
lasts until it is next launched.
