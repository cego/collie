# Collie runs its agents in herdr-core

**Status: draft.** Decided by the grill step of run-9ef16556, on the evidence of
run-34c2168f's evaluation (its `plan/INVESTIGATION.md` and `evaluation/01`–`05`).

It amends:

- [ADR-0003](0003-collie-is-one-effect-program.md): the herdr actions stop being a front
  door. The front doors are the CLI, Desktop and MCP.
- [ADR-0005](0005-collie-tab-is-an-application.md),
  [ADR-0009](0009-the-collie-tab-is-the-herds.md) and
  [ADR-0013](0013-the-board-is-cards-of-tasks.md): there is no Collie tab or Home
  workspace. The board is Desktop's, and the Ink board is a core terminal.
- [ADR-0044](0044-go-to-pane-opens-the-pane-in-desktop.md): Go to pane attaches to a core
  terminal instead of running herdr's pane controller.
- [ADR-0057](0057-a-machine-reaches-another-over-a-paired-link.md) and
  [ADR-draft-a-blocked-link-rides-the-machines-ssh-connection](draft-a-blocked-link-rides-the-machines-ssh-connection.md):
  core's machine list replaces herdr's as the list of Machines.
- [ADR-0062](0062-an-agents-question-is-asked-on-its-run.md): a Codex agent's question is
  asked on its Run, as a Claude agent's is.
- [ADR-0001](0001-compiled-runner-fetched-from-release.md) and
  [ADR-0048](0048-collie-is-released-for-macos-on-apple-silicon.md): Collie's signed
  release carries the `hc` it is verified against.

## What was true before

- **Herdr 1 held every agent.** herdr 0.9.x gave each agent a pane in a Task's workspace,
  detected its harness by `--kind` and reported its status. Collie spoke to it only
  through `src/herdr.ts`, pinned in `herdr-pin.json` and checked by
  `test/herdr-contract.test.ts`.
- **Herdr 1 is upstream's legacy.** herdr-core (`hc`) is the terminal runtime upstream
  builds on. Its horizon for 0.9.x is not published.
- **The evaluation measured core** (hc 0.1.14):
  - Claude, Codex and pi report status over OSC 7501 by themselves. OpenCode needs a
    35-line reporter.
  - No send was lost in 150.
  - Every terminal survived a core restart and an update.
  - A machine reconnected after a 60 s cut with one login, and a shared SSH master
    brought adding one from 5 logins to 1.
- **What it found missing:**
  - Codex ends a question turn `done`, never `blocked`.
  - `terminal.list` leaves out `machines`, which core's schema requires.
  - After a full stop, a kept terminal comes back as a shell, and core never reruns the
    agent.
  - Core has no workspaces, tabs, layouts, worktrees, notifications or agent detection.

## Decision

**D1. Herdr 1 is removed.** At the end there is no herdr plugin, no herdr socket or CLI
call, and no `herdr-pin.json`, `herdr-api-schema.json` or herdr contract test.

**D2. The cutover is staged, per Machine.**

- A core backend lands beside Herdr 1 behind the one boundary module.
- A Machine's setting decides which backend its new agents start on.
- Each incarnation records the backend it started on, and keeps it until it ends. So a
  Run that is in flight when its Machine switches finishes where its agents are.
- Herdr 1 is deleted only once no Machine is set to it and no live incarnation records
  it. Doctor says which still do.

Collie keeps working while its own Runs build this.

**D3. Collie uses each Machine's default core session.** Desktop, `hc ls` and `hc attach`
see the same terminals. Collie names each terminal by its agent's name and labels it with
its Run, operation and Task. Collie's tests and smokes use their own `HC_SESSION` and
scratch XDG directories, so they never touch the live core.

**D4. The window is Desktop.**

- Desktop draws an agent's terminal from core's attach stream, through the local core.
  This replaces herdr's pane controller from ADR-0044.
- The Ink board runs as a core terminal, so `hc attach` is a way in without a window.
  Native chat runs as one too.
- Neither has a layout: pane split, resize and swap are gone.
- The herdr plugin's actions, keybindings, picker popup and board pane are deleted.
- Notifications are Desktop's.
- Collie does not label terminals for herdr-app and ships no herdr-app mod.

**D5. Machines are layered.**

- **Core holds the terminals.** It holds every Machine's agents. The local core adds each
  Machine, so Desktop and the Host see and attach to all of them, with merged events and
  status.
- **A Run's agents start on its own Machine.** The Host of the Machine a Run is on starts
  them in that Machine's core. Another Machine's start still travels over the paired
  link, as it does today.
- **`run --on` is not Collie's launch path.** A call in flight when a link dies hangs
  about 35 s and then fails with "it may have happened there". One host acts for a Run
  ([ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)).
- **The paired link stays** as Collie's own authenticated, typed protocol between hosts:
  Runs, settings, credentials, upgrades and the Actor. Core is no permission broker and
  has no byte channel. The link's transport stays behind one interface, so a stream
  channel from core could carry it later.
- **Core's machine list is the list of Machines.** Pairing still happens on first reach.
- **Core never logs in by itself.** It reaches a Machine `--via` an ssh command that
  rides that Machine's SSH master from draft-a-blocked-link D3, and fails where no master
  is open. A front door opens the master, as that draft's D4 says, and core's own retry
  then succeeds. A cego VM costs one SSO approval for core and Collie together, never a
  prompt nobody sees.

**D6. Status comes only from OSC 7501.**

- herdr's per-harness detection is dropped.
- OpenCode gets a status reporter plugin through `OPENCODE_CONFIG_CONTENT`.
- pi has no question tool, so its questions do not come from a status reporter. A pi agent
  a Run launches is given Collie's `ask_user_question` in the per-launch extension Collie
  already writes. The tool asks on the Run the way ADR-0062's hook does for Claude's
  `AskUserQuestion`, and returns at once. Native chat's pi is not given it.
- Neither edits a settings file.
- Each pi agent is given a session id at launch with `--session-id`. It is recorded on
  the launch as its `agentSession`, for the agent to be resumed in.
- A Codex agent's question is read from the App Server Collie runs it through
  ([ADR-0059](0059-a-stopped-agent-is-stopped-where-its-turn-runs.md)). It is put on the
  Run as a Decision, the way ADR-0062 does for Claude's `AskUserQuestion`.

**D7. Delivery is `terminal.send`.**

- Stall recovery's read of herdr's prompt box (`agent explain`) is dropped: no send was
  lost in 150.
- A send that core says did not start is pressed once with `terminal.keys`, then reported.
- Collie leaves core's `notes` setting alone. Its sends, with no `caller` to an agent
  launched with `no_parent`, arrive unmarked: as measured on 0.1.14, core marks no plain
  send `<hc from="…">`. Each harness is shown live to act on such a step prompt before its
  Machine switches, and that live probe fails if a pin starts marking them.

**D8. Collie resumes its agents.**

- Agents start without `--keep`.
- Collie records each harness's session id at launch.
- After a holder loss or a full stop, the Host starts the agent again under its name, in
  its checkout (`--cwd`), with that harness's resume. It never types into a shell that the
  user's startup files may have moved.
- The board and chat terminals are started again plainly.

**D9. Collie owns what were Herdr 1's concepts.**

- A Task is Collie's record, and a label on its agents' terminals. There is no Task
  workspace, and no tab or pane label.
- Naming a Task writes only Collie's record.
- The worktree directory is a Collie setting, by default
  `~/.collie/worktrees/<repo>/<branch>`. Existing checkouts are not moved. Collie finds
  them through `git worktree list`.
- The state directory keeps its path, so no record is migrated. The `HERDR_*` names Collie
  passes between its own processes become `COLLIE_*` names when Herdr 1 is deleted.

**D10. Collie's release carries `hc`.**

- **The pin.** `hc-pin.json` pins `hc`'s version and SHA-256 for each platform Collie
  ships.
- **The release.** Collie's signed release carries that archive, for each of its runners
  ([ADR-0048](0048-collie-is-released-for-macos-on-apple-silicon.md) D3's keys). Core's
  own updates are checked only by a checksum from an HTTPS manifest, so they are not
  signed.
- **Install and update.** Install puts the binary where upstream's installer would, so
  the human's `hc` is the pinned one. A running core is updated only with
  `hc update --from` that binary. Collie never runs `hc update` from the network, or
  `hc machine update`.
- **Other Machines** get `hc` with Collie's own release, through the paired upgrade.
- **Doctor and onboarding** check and set up `hc`, not herdr. Doctor reports only the
  Machine it runs on: `hc` at the pin, its core answering, and what there still uses
  Herdr 1. `collie --machine <name> doctor` runs it on a paired one, over the host's
  existing shell call.

**D11. Core's API is checked two ways.**

- A contract test holds Collie's decoders to the pinned `released.openrpc.json`. It
  replaces `herdr-contract.test.ts`.
- A live probe runs the decoders against the pinned `hc`, in a session of its own. Each
  is needed: core's own test compares only schema with schema, and the 0.1.14 break was
  caught only live.
- `terminal.list` is decoded tolerating a missing `machines`.
- An upstream issue is drafted for the human to send. Collie files nothing upstream
  itself.

## Considered

- **Keep Herdr 1 (the evaluation's option A).** It costs nothing today. But upstream
  calls it legacy and publishes no horizon for it. The human chose the full move.
- **Core's machines instead of Pairing.** Rejected:
  - every reconnect would be an unattended SSO approval;
  - nothing would dial back to a laptop behind a VPN;
  - Collie's typed host protocol would have nothing to carry it.
- **herdr-app as the window.** Its mods cannot host a web view, so Desktop's React UI
  cannot move there.
- **`--keep` and typing the resume into the kept shell.** The user's shell startup can
  move it out of the checkout (measured: `~/.bashrc` `cd`s away). A fresh launch under
  the same name is one path for every harness.
- **Parsing a harness's prompt box for stall recovery.** It is a screen scrape per
  harness. Core's send lost nothing it would recover.

## Consequences

- One holder holds every terminal on a Machine. Losing it ends every agent, and D8
  resumes them.
- OpenCode reports no readiness, so its first prompt goes in at launch, not as a send.
- A Machine with no Desktop and no Slack gets no notifications. `hc attach` and the CLI
  still show every Run.
- Core is a preview (protocol generation 1). Each `hc` bump reruns the contract test and
  the live probe before the pin moves.
