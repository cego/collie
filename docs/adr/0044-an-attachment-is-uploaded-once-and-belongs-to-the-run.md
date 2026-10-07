# An attachment is uploaded once and belongs to the Run

**Status: accepted.**

A file given to a Run — a screenshot pasted into the Flock chat, a file a chat found on a
Machine, a file named with `--attach` — is named by its path on the Run's Machine and
copied by that Machine's host into the Run's own directory. It is a fact about the Run,
like its approved checks, and every agent prompt of the Run lists it with its path. A file
that is not on the Run's Machine yet gets there through the host, in parts, once.

## What was true before

A Run was given words and nothing else. The Flock chat's composer took text, a front door
could read a Run's files (`runFile`) but write none, and the only bytes Desktop sent to a
Machine went over `ssh … sh` (the credentials), which is the route a Run must not take.
A screenshot of the bug had to be described, or copied onto the Machine by hand and named
in the goal.

## Decision

**D1. A Machine gets a file through its host, in parts, by content.** `upload` is a
front-door operation ([ADR-0038](0038-the-host-builds-and-serves-the-board.md)). It takes
a file's name, size and sha256 and one part of its bytes at an offset, at most 4 MiB a
part, because the bridge's NDJSON frame is capped at 16 MiB and one larger frame closes the
whole channel. The host keeps the file in a store under its state directory by its sha256,
checks the hash when the last part arrives, and answers with the file's path there. A file
it already has is answered at the first part without taking the rest, so a file reaches a
Machine once however many Runs and steers it goes to. It refuses a file over the per-file
cap. Only a door whose file is on another computer uploads — Desktop, for what was pasted
on the PC or found on another Machine. Nothing goes by scp or ssh outside the bridge.

**D2. A start, a follow-up or a steer names files by path on the Run's Machine.** `start`,
`followUp` and a steer, and the `start`, `followup` and `deliver` actions, take
`attachments`: paths on that Machine — a path in the upload store, a file a chat found
there, or one the CLI or TUI was given. The host refuses a path that is not a readable
regular file, naming it, before anything is admitted. It copies each into
`runs/<id>/attachments/` before the Run's first step (a start, a follow-up) or before the
delivery (a steer), and records the names and where each came from in the operation's line
in `operations.jsonl`. A second request under the same id with other attachments is a
conflict, like any other change of arguments ([ADR-0017](0017-one-request-is-one-run.md)).
The host is the only writer of the Run's directory
([ADR-0040](0040-the-host-is-the-only-writer.md)); a door names a file, and never writes
one into a Run. A copy rather than a link: an agent that changes its attachment changes no
other Run's, and a pruned store loses nothing a Run holds. Within one Run, the same name
with the same content is the same file, and the same name with other content gets a short
hash prefix.

**D3. A Run-level fact, not an Input and not the Intent.** No Workflow declares an
attachment: a workflow's Input refuses a field it did not declare, so an Input would need
every module, a user's included, to change, and the Input feeds the execution id. The
Intent is versioned and is what drift is measured against, and an attachment that arrives
with a steer would bump its version and stale every pending proposal. Instead, the files in
`runs/<id>/attachments/` are the Run's attachments. The one function that renders every
step prompt lists each, with its path, size and media type, so every Workflow gets them
unchanged, and the list is read where the launch is decided, so a replay sends the prompt
it sent. A steer's delivered text gets a line for each attachment it brought, and the next
step's prompt lists it too. A Run starts with copies of the attachments of every Run in its
Lineage — the parent of a follow-up or a child, the plan Run an implementation builds — taken
when it is admitted, so its own directory is the whole list and outlives theirs.

**D4. The Flock chat sees them and hands them on.** Desktop keeps a copy of every
attachment, by sha256, under its own state directory. The message that carried them says
so in a block of Desktop's own beside the human's words — each one's name, size, media type
and the path of Desktop's copy — so the model can name it later and a conversation read
back after a restart shows it again, from the transcript Claude Code already keeps. The
model is also shown each one: an image scaled to at most 2000 px on its long edge, because
a request with more than 20 images in it refuses anything larger and the conversation's
history counts; a PDF up to 4 MB as a document; UTF-8 text up to 100 KB as text; anything
else, or anything larger, only by that block, and the chat reads it with its own tools.
A start, follow-up or steer the chat carries out takes the attachments it is given — a path
on this computer, `<machine>:<path>` for one on a Machine — and, given none, those of the
message that asked for it, which the tool host attaches as it attaches the human's words.
Desktop uploads each that is not already on the action's Machine (D1) and hands the host
paths there. The chat's voice names the attachments the human's message carried, so a write
recorded with their words says what came with them
([ADR-0039](0039-every-operation-records-who-asked.md)).

## Consequences

- The host prunes its upload store a week after a file arrived: a Run holds its own copy,
  and a file uploaded for a start that was refused does not stay for ever. A proposal
  confirmed later than that is refused naming the file, and Desktop uploads it again.
- Desktop prunes its copies after 30 days, as Claude Code prunes the transcripts that name
  them. A conversation older than that shows the attachment's name without its thumbnail.
- A conversation that accumulates more than the API's 32 MB request size in images and
  documents fails every turn until a fresh one is started. Scaling keeps an image small,
  and a large PDF or text goes by name, so it takes many attachments to get there.
- An attachment given to a finished Run's follow-up is copied again into the follow-up's
  directory: disk, not upload.
- An older host does not know `upload` or `attachments`, and its decoder drops a field it
  does not know rather than refusing it, so it would start the work without the files. The
  board snapshot says whether a host takes files (an optional field, so the protocol stays
  2), and a door that needs them says that Machine's Collie must be upgraded, and starts
  nothing.
- The board's free-words Steer (`steerAbout`) carries no attachments: the chat steers with
  `deliver`, and the CLI with `run steer --attach`.
