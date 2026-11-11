# A file given to a pane is placed on its Machine

**Status: draft.** Decided on run-f0d81d1d, where the human asked to paste and drop files
into a Run's terminal "for all harnesses, local or remote".

It extends [ADR-0046](0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md) from
the Flock chat to a Run's pane, and builds on
[ADR-0044](0044-go-to-pane-opens-the-pane-in-desktop.md) (Go to pane) and
[ADR-draft-collie-desktop-is-drawn-by-rune](draft-collie-desktop-is-drawn-by-rune.md).

## What was true before

- **A pane took text only.** A paste into a Run's terminal typed the clipboard's text,
  and nothing was dropped on it.
- **An image reached an agent only through its harness.** Claude Code, Codex, OpenCode and
  pi each read a pasted image from the clipboard of the computer they run on, each in its
  own way, and some not at all. An agent on another Machine has no clipboard of the
  human's, so pasting a screenshot there was flaky or did nothing.
- **The Flock chat already carried files** to a Machine through its host's `upload`, once
  per content (ADR-0046 D1, D4).

## Decision

**D1. A file given to a pane is typed as its path on the pane's Machine.** A paste with
files on the clipboard (Ctrl+Shift+V, or Ctrl+V when the clipboard holds files or an
image), a pasted image, or files dropped on the window while a Run's Terminal tab is shown,
are given to that pane:

1. Desktop stages them on this computer, as the chat's Attach does (`stagePaths`, `stage`,
   `clipboardFiles`).
2. `placeFiles { installation, ids } → paths` uploads each of Desktop's copies to the
   pane's Machine.
3. Desktop types the paths there into the pane as one paste, shell-quoted and
   space-separated, in the pane's own paste mode (bracketed where its program asked). It
   does not press Enter.

Every harness reads a file by its path, and Claude Code and Codex show an image they are
given that way. Teaching each harness's clipboard integration to reach another computer
would be four integrations, each changing under us, and still nothing for a shell.

**D2. Placing goes through the host's `upload`.** It reuses ADR-0046 D1 unchanged: the
host keeps a file once by sha256, in parts of at most 4 MiB, and answers its path. Desktop
uploads a content to a Machine once a day. A local Machine is uploaded to as well, as the
chat's do: one route, and the path typed is in the host's store, which the cleanup sweep
keeps for a week. Nothing goes by scp or by a second SSH connection, and a Machine whose
Collie does not take files is named and nothing is pasted.

**D3. All or nothing.** A paste with text and files gives the files. A plain text paste
is typed as before. A file that cannot be staged or placed is said in the Terminal tab's
status and in Desktop's log, and nothing of that paste is typed. A pane closed or replaced
before its files are placed is typed into nothing.

## Consequences

- On Wayland, winit reports no file drops, so files reach a pane by paste only, as they
  reach the chat (ADR-draft-collie-desktop-is-drawn-by-rune D2).
- Ctrl+V reads the clipboard before it is typed, so a pane's own Ctrl+V arrives after that
  read. With an image on the clipboard, a harness that reads its own clipboard now gets a
  path instead.
- A typed path is text for the harness to act on. Whether it shows a path's image inline
  is the harness's own behaviour.
- Only the Rune shell gives files to a pane; stable Desktop's view is unchanged. The core's
  `placeFiles` is additive and spoken by nothing else.
