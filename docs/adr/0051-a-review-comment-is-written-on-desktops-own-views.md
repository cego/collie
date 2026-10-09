# A review comment is written on Desktop's own views and delivered word for word

**Status: accepted, to be built.**

A human reviews a Run's plan and its diff in the card's record in Desktop. They comment on
a quoted span of the plan or a line range of the diff, and they send the comments together
to one of the Run's agents as one Delivery, word for word. Plannotator was looked at for
this and is not used. The diff it draws with, `@pierre/diffs`, is.

## What was true before

The record's Plan tab rendered `SPEC.md` and the tickets. Its Diff tab drew the Run's
branch against its merge base: a file tree, unified or side by side, each file's patch
read over the bridge and highlighted with Desktop's own parser and Shiki. The human could
read both, but they could say nothing about one line except by describing it. They could
type it into the card's Steer…, which a model turns into actions, or into the agent's pane.
The plan workflow's Refine asks its questions one at a time, in the planner's pane.

A message longer than the Dispatcher's cap, `MAX_DELIVERY_BYTES` (8 KiB), was refused as
`too_long` whichever door sent it. An open ticket in the Plan tab was read once and not
again. The host kept a finished Run's plan for its own life, because a finished Run's plan
was taken to be unable to change.

## Decision

**D1. A comment is written where the human reads.** In the Plan tab, the human selects
text in `SPEC.md` or a ticket and comments on it. In the Diff tab, they pick a line or a
range on either side of a file and comment on it. Desktop holds comments per Run as drafts
until they are sent. A draft is not a Collie record, and no host operation exists for one.

**D2. The comments go as one Delivery, word for word.** Desktop composes a Run's drafts
into one message. For each comment, the message gives the location (the plan file, or
`path:line` and which side), a short quote of what the comment is about, and the human's
words. Desktop sends that message as the closed `deliver` action through `act`. It does not
use `steerAbout`, because there a model rewords the request, and a reworded review is not
the one the human wrote. The message goes to the Run's newest live agent: the last agent
the Run launched that herdr still has, which is the one Go to pane opens. The human can
pick another of the Run's live agents. Nothing is added to `FrontDoorRpcs`, so `PROTOCOL`
stays the same. An agent can do the same thing with `collie run steer --agent` or chat's
`deliver`, at any length, because the composed message is just text (invariant 1, and D3).

**D3. The host keeps a message over the cap as a Run attachment.** One delivery is at most
`MAX_DELIVERY_BYTES` (8 KiB). Where the text a steer would send is over that, the host's
`steer` writes the words into the Run's `attachments/` as one Markdown file
([ADR-0046](0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md)). It then
delivers a short line that says the message is in that file, with the file's `Attached:`
line. This holds for every door, because every door's delivery reaches the host's `steer`.
A message is never split into several deliveries, because the agent would act on the
first part before the rest arrived. Desktop does not know the cap.

**D4. Only the Run's own agents change the plan, and the Plan tab shows what they wrote.**
A front door cannot write into a Run's directory
([ADR-0040](0040-the-host-is-the-only-writer.md)). A comment on the plan asks the agent to
change it. Desktop never edits `SPEC.md` or a ticket itself. Each ticket in a Run's plan
carries a stamp that changes whenever its file does, and the Plan tab reads an open ticket
again when its stamp changes. A finished Run's agent can still be steered
([ADR-0041](0041-a-finished-run-still-takes-steering.md)), so its plan can still change.
The host reuses a finished Run's plan only while none of its files has changed.

**D5. The Diff tab draws with `@pierre/diffs`.** It uses the library's framework-free
`FileDiff`. Each file's patch is the one the host already serves, drawn split or stacked.
The library's line selection, gutter button and line annotations hold the comments. It
replaces Desktop's own patch parser and its diff highlighting. The library is Apache-2.0
and built on Shiki (3 or 4), as Desktop's highlighting is, and it draws into a shadow root,
so its styles and Nuxt UI's stay apart.

**D6. A comment on the diff goes to the Run's agent, not to the merge request.** The Diff
tab shows the Run's branch against its merge base, which is what the merge request shows.
Comments are not posted to the forge.

## Considered

Plannotator was read at 0.28.8 (commit `545c7af`, 2026-10-08). It is MIT OR Apache-2.0;
its library packages `@plannotator/ui` and `@plannotator/core` are Apache-2.0 only.

- **Plannotator's views inside Desktop's.** They are React 19. Each review mode (plan,
  review, annotate) is its own `Bun.serve`, about 108 `/api` paths between them, and the
  pages fetch `/api/…` by relative URL with no setting for another base. They cannot
  become part of Desktop's Vue views. `@plannotator/ui` has a library mode that swaps its
  transports, but it is React TSX. The page can be framed: Plannotator's VS Code extension
  does it through a cookie proxy. A frame still needs Plannotator's own server for each
  review, behind a same-origin proxy that passes its Host check, so it costs everything
  below and a proxy besides. The only part that can be reused is `@pierre/diffs`, which
  Plannotator uses too (D5).
- **Plannotator run beside Collie.** This works, and Plannotator's own Claude Code and
  OpenCode integrations run it this way. `plannotator annotate <dir> --gate --json` and
  `plannotator review <dir> --base <ref> --json` start a review, and
  `PLANNOTATOR_SKIP_BROWSER_OPEN` and `PLANNOTATOR_READY_FILE` let a host start it and
  find its page. Annotations can be pushed in through `/api/external-annotations`. Its
  result has no version field: `review --json` gives `{decision, message}`, where the
  message is already written for an agent. It was turned down for what it costs:
  - a third-party binary on every Machine, a compiled Bun binary from GitHub releases and
    not on npm, which Collie would pin and verify itself
    ([ADR-0048](0048-collie-is-released-for-macos-on-apple-silicon.md)); its installer
    writes hooks and skills for Codex, Gemini, Kiro and Vibe unless run with `--minimal`;
  - on a remote Machine, a port Desktop reaches through the SSH master, which is the kind
    of listener [ADR-0044](0044-go-to-pane-opens-the-pane-in-desktop.md) D2 avoided;
  - a review process for each Run, which the host would start, watch, close and clean up;
  - `annotate <folder>/` saves edited files through its Edit Mode, which would make a
    front door a writer of a Run's plan, against D4 and ADR-0040, unless kept off;
  - features to switch off and keep off: Ask AI and agent reviews, which start Claude or
    Codex sessions of their own whose usage Collie never records
    (`PLANNOTATOR_AI=disabled`); link sharing to `share.plannotator.ai`
    (`PLANNOTATOR_SHARE=disabled`); and a check of GitHub for a new release every time a
    page loads, which no setting turns off;
  - a separate window in Plannotator's own design;
  - a check of every Plannotator release, and it releases often: 39 releases in the 60
    days to 2026-10-08.
- **`steerAbout` for the send.** That is the card's Steer…, where a model turns the words
  into actions. A review should reach the agent exactly as the human wrote it.
- **Answering the plan's Refine with the comments.** The workflow would need a menu answer
  to carry text, and it would work only for a plan Run that is waiting at its menu. A
  Delivery works for any Run with a live agent, including a plan Run at its menu.
- **Desktop uploading a message over the cap.** Desktop would need the Dispatcher's cap,
  moved out of host code into the board model, and a chunked upload of its own; the one it
  has belongs to the Flock chat. The same message from an agent through
  `collie run steer --agent` would still be refused as `too_long`, so D2's "an agent can do
  the same thing" would hold only under 8 KiB.

## Consequences

- Drafts that have not been sent are lost if Desktop quits.
- A Run with no live agent cannot be sent comments. The send says why, as a steer does,
  including a finished Run's follow-up route
  ([ADR-0041](0041-a-finished-run-still-takes-steering.md)).
- A plan comment sent after Implement now reaches the planner, but the implementer is not
  told what changed. Only the menu's rounds write a changelog for it. A steer to a plan Run
  has the same gap today.
- `collie run steer`, chat's `deliver` and Desktop's comments deliver a message over
  8 KiB as a file in the Run, where they used to refuse it. A Machine whose Collie predates
  this still refuses one; Desktop shows the host's words and keeps the drafts.
- The host reads each finished plan's file stamps on every drawer build, where it used to
  read nothing after the first build.
- Desktop gains a dependency on `@pierre/diffs`. Its highlighting for diffs is the
  library's, and `SourceFile` keeps Desktop's own highlighting.
