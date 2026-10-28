# A finished Run is seen once, for the Flock

**Status: accepted, to be built.** Builds on
[ADR-0013](0013-the-board-is-cards-of-tasks.md) (cards of Tasks),
[ADR-0039](0039-every-operation-records-who-asked.md) (who asked) and
[ADR-0040](0040-the-host-is-the-only-writer.md) (the host writes). Leaves what is
**Finished**, and so what **Cleanup** waits for, as it is.

vm-mk:run-b4c13d24 was a read-only `general` audit. It completed with a verdict, the
blockers that remained and next steps. Its Task had nothing to land, so it went into
Finished, and Desktop and the TUI both draw Finished collapsed. The only other sign was one
proactive Flock chat turn. A human who was away, on another Machine's Desktop or scrolled
past that turn had nothing to point them to it. The card's sentence, `Finished; it says:
“…”`, also read as "done" for a Run whose report was a list of blockers (#213).

## Decision

**D1. Seen is the host's, per Run.** The host of the Machine that has the Run records that
it was seen. The record is append-only in the Run's own record, beside its disposition,
and says who and when (ADR-0039). Every Desktop and board reads it from that host, so one
acknowledgement clears it for the whole Flock, across restarts. A second acknowledgement
changes nothing.

**D2. What is unseen.** A Run is unseen when all of these hold:

- its Task is Finished and the Run leads it;
- it ended by itself, with no disposition anyone recorded;
- it reported something, a summary that is not empty;
- nobody has seen it.

A Run that ended before its host first started with this decision counts as seen. That
host writes the moment into its state directory once, so an upgrade does not bring back
every old report. A failed or stopped Run is not in Finished, so this does
not apply to it.

**D3. Any door clears it, and only on purpose.** Opening the Run's record in Desktop or
the TUI's drawer records seen. So does an explicit acknowledgement from the card, the CLI,
a herdr action or an agent's `collie_do`, through one host operation with a request id.
Reading the Run, as `collie run show`, `collie_run` or the Flock chat's turn about it do,
records nothing. Otherwise the turn that is easy to miss would clear the signal that is
meant to outlast it.

**D4. An unseen card is drawn where it is not collapsed.** Its section is still Finished,
so Cleanup and the board's counts are unchanged. Desktop and the TUI draw it above the
collapsed Finished list, marked unseen, until it is seen. Then it folds into the list.

**D5. Its sentence keeps the Run's status apart from what it reported.** The status comes
first, as the Run's own word. The report follows, quoted as what the Run said. Nothing in
the sentence says the goal was met.

**D6. Seen settles the Run's ended News.** A Run's `ended` item stops being news for every
conversation that has not read it, as a disposition already does. So a Machine that comes
back later does not raise it again.

## Rejected

- **Seen kept by each Desktop.** It would not clear across Machines or for an agent, and
  #213 asks for one acknowledgement to clear it everywhere.
- **An unseen Run moved to Waiting on you.** Waiting on you means the work has not landed,
  and Cleanup reads Finished. A mark that is drawn differently changes neither.
- **An OS notification.** It was not asked for, and the board signal lasts where a
  notification does not.
