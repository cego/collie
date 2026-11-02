# Go to pane opens the pane in Desktop, over the Machine's own connection

Amended by [ADR-draft-collie-runs-its-agents-in-herdr-core](draft-collie-runs-its-agents-in-herdr-core.md): Go to pane attaches to a core terminal instead of running herdr's pane controller.

**Status: accepted, built.** Amended by
[ADR-draft-a-blocked-link-rides-the-machines-ssh-connection](draft-a-blocked-link-rides-the-machines-ssh-connection.md):
Go to pane rides the Machine's shared SSH connection, which outlives Desktop. It replaces the sentence in
[`docs/internals.md`](../internals.md#the-herdr-boundary) that said Desktop "asks it
nothing and reads nothing from it", and the exception in invariant 3 of
[`AGENTS.md`](../../AGENTS.md) for "the herdr client Go to pane opens in a terminal for
the human". Nothing else about the herdr boundary changes.

## What was true before

Go to pane (#58) asks the card's Machine to focus the Run's newest live agent. It then
opens `herdr --remote <target> --session <name>` in the PC's default terminal. herdr's
remote attach makes its own SSH connection, with a private control socket for each
attach. So every Go to pane is a new SSH login, and vm-mk's sshd asks for an SSO approval
at sso.cego.dk each time. Desktop already holds an authenticated master for that Machine
(`ssh -M -S <control>`), and every bridge Desktop runs is one more channel on it. Go to
pane also needs herdr installed on the PC and a terminal emulator that Desktop can find.

herdr has shipped a bridge protocol for exactly this since 0.7.2, and the pin is 0.8.2.
`herdr terminal session control <target> --takeover --cols N --rows N` prints one
newline-delimited JSON record per `terminal.frame`:
`{type, seq, width, height, full, encoding: "ansi", bytes: <base64>}`. It ends with a
`terminal.closed` record. On stdin it reads `terminal.input` (`text`, or base64 `bytes`),
`terminal.resize` (`cols`, `rows`), `terminal.scroll`, `terminal.mouse` (0.9.2 and later)
and `terminal.release`. herdr's server emulates the terminal itself with libghostty-vt.
The frames it sends are its own rendering of that state, so the client only has to draw
them. A controller is herdr's direct attach: it holds a resize lock on that one pane, and
`--takeover` replaces another direct-attach owner without touching a full herdr window.

## Decision

**D1. The pane opens in Desktop.** Go to pane shows the Run's live agent's terminal in a
Terminal tab of the card's drawer. xterm.js draws herdr's frames. Keystrokes, pastes,
resizes and the scroll wheel go back to herdr as controller commands. The pane's history
belongs to herdr: scrolling moves herdr's view of the pane, and the renderer keeps no
scrollback of its own.

**D2. It runs over the Machine's route.** The controller is started with the route's own
shell command: one more channel on the master Desktop already holds, or a local process
for Local. There is no new SSH connection, no new login, no listener, no forwarded socket,
and nothing to install on the PC.

**D3. Desktop draws the pane and decides nothing from it.** Bytes go from herdr to the
renderer, and the human's keys go back. Desktop never parses what the pane shows to decide
anything. It is the human's herdr client, as the external one was. The host still finds and
focuses the pane through `herdr.ts`, and its `focus` reply now also names the pane. That
field is additive, so `PROTOCOL` stays the same.

**D4. Control is held only while the tab is shown.** Desktop takes over, because the human
asked to go to that pane. It releases the pane when the tab is left or the drawer closes.
That lifts herdr's resize lock, so the pane goes back to its layout size in any herdr
window. A terminal that ends says why: the pane closed, another client took it over, the
Machine's connection dropped, or herdr refused. The human can reattach from there.

**D5. The external herdr client stays for what the tab cannot show.** It is used for a Run
with no live agent, for a host whose `focus` reply names no pane, and when the human asks
for the full herdr UI.

## Considered

- **Embedding libghostty.** Only `libghostty-vt` is public: a parser and terminal state,
  with no renderer, untagged, and with C API signatures "still in flux". A GPU surface
  inside an Electrobun window would need three native integrations, one each for CEF on
  Linux, WKWebView on macOS and WebView2 on Windows, plus focus, IME and compositing over
  the webview. It would also add nothing: herdr already runs libghostty-vt on the Machine
  and sends rendered ANSI.
- **ghostty-web in place of xterm.js.** It has the same API over libghostty-vt in WASM,
  but it is at 0.4.0 with `next` builds. Its better parser does not matter here, for the
  same reason as above. Because the API is the same, it can be swapped in later.
- **The external terminal over Desktop's master** (`ssh -S <control> -t <target> herdr
  --session <name>`). This is a small diff that ends the extra SSO. But the pane is still
  in a separate window, and the herdr UI runs on the Machine instead of the PC. The
  terminal also dies when Desktop quits, because the master has `ControlPersist=no`, and
  the command the card offers to copy would contain a temporary socket path.
- **Sharing a ControlPath** with herdr's saved-machine connection, or with one in the
  user's `ssh_config`. herdr's path is private and undocumented. Two owners would hold one
  master with different persist times, and the window problem stays as it is.
- **The host relaying the terminal over `FrontDoorRpcs`.** Every keystroke would become an
  operation under a request id, recorded with its Actor
  ([ADR-0039](0039-every-operation-records-who-asked.md)). That would put whatever the
  human types into a Run's operations journal. Effect RPC also has no client stream, and
  the relay adds two hops. The host is the only writer of Collie's records
  ([ADR-0040](0040-the-host-is-the-only-writer.md)); it is not a relay for the human's
  terminal.
- **A local proxy socket**, forwarding the Machine's herdr socket to one on the PC. That
  needs herdr on the PC at a compatible protocol, and herdr's client finds its socket from
  its session directory. It has more parts than running the controller where herdr already
  runs.

## Consequences

- A Machine needs herdr 0.7.2 or later for the in-app terminal. The pin already meets it.
- While the tab is shown, the pane's size follows Desktop's, including in a herdr window
  that has the pane open.
- No new listener and no new credential. The renderer does not honour OSC 52 clipboard
  writes, and a link in the pane opens only in the human's browser through `openLink`.

## Amended 2026-10-08: the Terminal tab shows any of the Task's live agents

A Task often has several live agents at once, such as its planner, implementer and
reviewers, and the tab could reach only the newest of one Run's. The tab now lists every live
agent the card counts, labelled with its role and its herdr status, and the human picks which
pane to show. Picking one releases the pane shown and takes the chosen one, as Reattach does.

- The board names each agent's role, from the registry entry it was registered with: the
  same role its herdr tab is labelled with.
- `focus` may name one agent of the Run. The host then focuses that agent, or the Run's
  workspace where herdr no longer has it. Its reply names the agent it focused, so the tab
  marks the pane it is showing from what the host did, not from what was asked.
- All three fields are additive, so `PROTOCOL` stays the same. A host older than this
  ignores the agent asked for and names none, so the tab marks none as shown.
- Go to pane and Reattach without a choice still find the Run's newest live agent. Reattach
  after a choice finds the chosen one again.

## Amended 2026-10-09: the tab opens on the agent at work, fills the record and takes the keys

The tab opened on the newest registered agent of the card's Run, which is often idle while
another of the Task's agents works or waits for the human. It sat in a box 70% of the
window high, beside a scrollbar gutter that nothing used. It drew in whatever the PC calls
`monospace`. On Omarchy that is DejaVu Sans Mono, not the CaskaydiaMono that every other
terminal there uses. In the screenshot that prompted this, the view drew at two device pixels per CSS
pixel and the glyphs were drawn at that density. The blur came from the font, not
from a backing store: xterm.js 6 draws with its DOM renderer, which has no canvas to size.

- **Which agent.** Opening the tab, Go to pane, and Reattach before a pick all show the Task's
  agent that is `blocked`, else one that is `working`. Among several, the card's own Run
  comes first, then the agent registered last. Where none is either, the tab asks for the
  card's Run's newest live agent as before, so a Run with no live agent still opens herdr's
  own client. Before a pick, Go to pane opens herdr's own client wherever the agent asked
  for has no pane, so a host whose `focus` names none still does. This replaces the last bullet of the amendment above. The choice is read
  from the statuses the board already carries, never from what a pane shows, so D3 holds.
  A pick lasts until the tab is left. The tab never switches by itself while it is shown.
- **Size.** The tab fills the record below its tab bar, with the same margin on both sides
  and no scrolling. herdr's pane is resized to the cells drawn, and again after every change
  to the window, the Flock chat beside it, or Desktop's zoom.
- **Keys.** The terminal takes the keyboard when the tab opens, after a pick or Reattach,
  unless a field outside its box has it, and on any click inside its box.
- **Type.** The terminal draws in CaskaydiaMono Nerd Font where it is installed, then in
  common terminal fonts, then in the platform's monospace. It draws at 16 CSS pixels:
  Ghostty's default 12pt on a 96-dpi Linux desktop. xterm.js keeps its DOM renderer. That
  renderer rasterises text with the browser's own renderer at the device pixel ratio
  Desktop's page zoom sets ([ADR-0047](0047-desktop-draws-at-its-monitors-own-scale.md)).
  The WebGL addon would add a GL context that can be lost, and its glyphs would be no sharper.
