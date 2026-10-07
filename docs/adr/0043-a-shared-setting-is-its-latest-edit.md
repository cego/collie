# A shared setting is its latest edit

**Status: accepted.**

Collie's settings are shared by every Machine in a Flock, and each key is decided by
whichever edit of it was made last, wherever it was made. The host records when each key
was set.

## What was true before

Each Machine's `config.json` was its own, edited only in that Machine's TUI Settings. A
human with three Machines set `model` three times, and a Machine they forgot ran with
another. Desktop shared only what it held itself: the GitLab host and the tokens.

## Decision

**D1. One list says what a setting is.** `src/settings.ts` lists every setting: its key,
its kind, its choices, its default and what it refuses. The TUI's Settings, Desktop's
Settings and the host read it, so a setting added there is offered, validated and shared
everywhere. Everything else in `config.json` — remembered answers, `chat_harness`, and
`projects.root`, a path on one Machine — stays that Machine's.

**D2. The host records when each key was set.** Every write of a setting, from the TUI or
from a front door, goes through one function that writes `config.json` and stamps the key
in `settings-set.json` beside it. A value written before stamps existed is dated by the
file's time. Clearing a key is an edit too.

**D3. The latest edit wins, per key.** Desktop keeps the Flock's settings, each with its
edit's time and the Machine (or Desktop) it came from. Syncing a Machine reads its
settings, takes each key the Machine edited later, and gives the Machine each key it holds
an older edit of, with that edit's own time. The host writes a key only where the given
edit is later than its own, so an edit made on the Machine while Desktop was syncing
survives and comes back in the reply. On the first sync a key set on one Machine only is
taken from it; a key set differently on several takes the latest, and Settings says which
Machine that came from. A value its setting refuses is not taken. `gitlab_host` is the one
exception: Desktop gives it and never takes it, because the GitLab token Desktop holds was
made for its host.

**D4. Through the host, never over SSH.** `settings` and `setSettings` are front-door
operations ([ADR-0038](0038-the-host-builds-and-serves-the-board.md)), recorded under the
Actor that asked ([ADR-0039](0039-every-operation-records-who-asked.md)). They are an
additive change, so `PROTOCOL` stays. A Machine on an older collie fails the read and is
synced after Desktop upgrades it, as every older Machine already is.

## Consequences

- An edit reaches a Machine out of reach when it next connects, the same way an upgrade
  does. An edit made on such a Machine meanwhile still wins if it was later.
- Clocks decide. Machines whose clocks disagree by more than the time between two edits
  of one key can keep the earlier one. Collie does not correct for that.
- A Machine's TUI Settings says a setting is shared with the Flock once a Desktop has synced
  it, and an edit there spreads to every Machine. Only a Desktop's sync records that.
