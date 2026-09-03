# Using Collie

This is the operator's guide: how to install Collie, start a run from inside herdr, read
the Control Plane, answer what a run asks you, and pick up where you left off. For the
vocabulary — Run, Step, Driver, Choice, Hand-off — see [`CONTEXT.md`](../CONTEXT.md).

## Install

One command, safe to re-run:

```sh
git clone git@gitlab.cego.dk:mk/collie.git ~/.collie && ~/.collie/setup.sh
```

`setup.sh` does its own work — clone the checkout or pull it, add the three keybindings
below to `~/.config/herdr/config.toml` if they are missing, reload a running herdr — and
calls `prepare.sh` for everything else. That is the one routine that prepares a
machine, and `collie upgrade` and herdr's plugin build hook end in it too, so a prerequisite
is added in one place:

| Step             | What it does                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `plugin-link`    | `herdr plugin link` from this checkout, if it is not already linked from it                  |
| `runner`         | `install.sh`: the runner in `bin/collie`, and a `collie` shim on your PATH                   |
| `operator-skill` | Links the Collie operator skill into `~/.claude/skills/collie` and `~/.agents/skills/collie` |
| `skills`         | Installs and updates the skills the workflows require (below)                                |

Every step skips what is already in place, so re-running is a reflex rather than a
decision. `install.sh` writes the shim without changing PATH itself. Keybindings are the
one thing `prepare.sh` never touches: writing to your herdr config is not something a
plugin rebuild may do as a side effect, so `setup.sh` alone adds them.

`setup.sh` ends by running [`collie doctor`](cli.md#checking-an-installation) and exits with
its status, so an install's last word is either that everything is ready or what is missing
with the fix for each.

Collie is internal, so downloading a release asset needs a token. An unauthenticated
request gets a sign-in page rather than a binary — with HTTP 200, which is why the install
checks that what arrived is a program rather than trusting the status code.

The install finds a token in this order:

1. `COLLIE_TOKEN`, if you set it — a personal access token with `read_api`:

   ```sh
   COLLIE_TOKEN=glpat-… ~/.collie/setup.sh
   ```

2. The login the host's own CLI already holds. For a GitLab release that is
   `glab config get token --host <host>`, and for a GitHub one `gh auth token --hostname
<host>`. Which of the two it asks comes from the release URL: GitLab download paths
   carry `/-/releases/`, GitHub's carry `/releases/download/`, so a self-hosted instance of
   either is recognised by its shape rather than its hostname. If you have run
   `glab auth login` for the host, the install needs nothing else from you.

The token is passed to `curl` through its config file on stdin rather than `--header`, so
it never appears in the process arguments that `ps` shows other users on the machine.

Without any token, a machine with bun builds the runner from source instead — which is what
a checkout does anyway, because its own source is what a release is cut from. A machine
with neither a token nor bun says so and stops rather than installing whatever came back.

`collie upgrade` does the same thing later: it pulls first where the installation is a
checkout (`--ff-only`, so it never quietly merges local work), then runs the same
`prepare.sh` steps and reports what each of them did. A pull it cannot do is reported
rather than installed over. The Control Plane says when this installation is behind its
remote, so you upgrade because you know you are stale rather than because you remembered
to.

### The skills

The baseline workflows hard-require ten skills they do not ship, and a missing skill stops
a run before its first tab opens. `prepare.sh` installs them for you with the
[skills.sh](https://skills.sh/) CLI (`npx skills`), from three sources:

- `https://github.com/mattpocock/skills/tree/main/skills/engineering`
- `https://github.com/mattpocock/skills/tree/main/skills/productivity`
- `https://github.com/addyosmani/agent-skills`

The CLI itself is pinned to a version, where the skills it installs are not: that is an
executable running unattended with your shell's privileges on every install and upgrade,
which is a different question from what a skill's text says. Bumping it is a deliberate
one-line change.

The first two sources are what that repository's own plugin manifest defines as its
official bucket. They are added by _path_, not as a list of skill names, so a skill added upstream
inside those directories arrives on your next upgrade.

They are installed globally into `~/.agents/skills`, which is the standard location and
the first place Collie's own skill lookup already searches — pi, codex and opencode read it
directly and get no special handling. Claude Code does not read it, so it is named as an
install target as well and gets a symlink per skill; nothing is copied twice.

**Versions float.** Every install and every `collie upgrade` takes the latest upstream
state; there is no lockfile and nothing is vendored here. The mechanism is the CLI's own
global update ([ADR 0005](adr/0005-skills-float-and-are-not-pinned.md) names it), so any
other skill you have installed globally is brought to _its_ own latest at the same time —
each from the source it already records, never repointed at ours. If one of those cannot
be reached, the step says so and stops there; the three sources above stay installed and
are not fetched again on the next run. The cost is real and worth
knowing: several steps read a skill's _output contract_, so an upstream change to what a
skill writes can break a workflow with no change on our side. The symptom is a step whose
output cannot be read, and upstream is the first place to look. The reasoning is
[ADR 0005](adr/0005-skills-float-and-are-not-pinned.md).

The step needs the network and a Node runtime, and neither is a reason to leave you without
a runner. If either is missing the step says so in one line, the rest of the install
completes, and `collie upgrade` picks it up next time.

### Environment variables

| Variable              | Contract                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `COLLIE_DIR`          | Checkout used by `setup.sh` when it is run outside a checkout; defaults to `~/.collie`.                                                      |
| `COLLIE_REPO`         | Git URL cloned by `setup.sh`.                                                                                                                |
| `COLLIE_TOKEN`        | Personal access token (`read_api`) used to download a release asset. Optional where `glab` or `gh` is already logged in to the release host. |
| `COLLIE_BIN_DIR`      | Where `install.sh` writes the `collie` on your PATH; defaults to `~/.local/bin`. `collie doctor` looks there for a shim that is not on PATH. |
| `CLAUDE_SKILLS_DIR`   | Claude Code's skill store, where `prepare.sh` links the operator skill beside `~/.agents/skills`; defaults to `~/.claude/skills`.            |
| `COLLIE_RELEASE_BASE` | Base URL from which `install.sh` downloads `collie-<os>-<arch>`.                                                                             |
| `COLLIE_DRIVER`       | Driver executable for development and tests: one executable path, or a JSON array containing the executable and arguments.                   |
| `COLLIE_MODE`         | Internal picker mode passed from a herdr action to its picker pane.                                                                          |
| `COLLIE_RUN`          | Internal Run ID passed to a detached Driver.                                                                                                 |
| `COLLIE_CWD`          | Working directory passed to picker, agent, and Driver processes; also re-roots a CLI run.                                                    |

`COLLIE_MODE` and `COLLIE_RUN` are process-to-process contracts set by Collie; you do not
set them yourself.

### Keybindings

`setup.sh` adds these if they are missing (`prefix` is `ctrl+b` by default; edit them in
`config.toml` afterwards). Plain letters on purpose: `alt` chords after the prefix are not
delivered reliably over SSH or through some terminals, and herdr's own config notes the
same.

| Key              | Action                                                          |
| ---------------- | --------------------------------------------------------------- |
| `prefix+f`       | `cego.collie.pick` — run a workflow                             |
| `prefix+u`       | `cego.collie.resume` — resume a run with unfinished steps       |
| `prefix+shift+f` | `cego.collie.fork` — copy a workflow or persona into your layer |

They show up in herdr's keybind help (`prefix+?`). Without a binding, any action still
runs from a shell inside herdr: `herdr plugin action invoke cego.collie.pick`.

## Start a run

1. Focus a pane in the workspace of the repo you want to work on and press `prefix+f`.
2. Pick a workflow in the popup (type to filter, Enter). See
   [Workflows](workflows.md) for what each one is for.
3. Inputs are inferred from the branch, open MR and earlier runs; you are asked only for
   what could not be inferred, and shown one confirm line. Two inputs offer a menu instead
   of a guess: `implement`'s work source, and `review`'s target.
4. The workspace's **Control Plane** tab opens, and it is always the workspace's first
   tab, so `prefix+1` lands on it.
5. The run's own tabs hold agents and nothing else: one tab per step, a step's parallel
   variants side by side in it with an even share each, a step that reconciles them
   (`fan_in:`) underneath them in the same tab, and a step that continues an earlier agent
   opening nothing at all — it renames that pane to itself, so `build` becomes
   `architecture`, then `simplify`, then `fix`. Tabs are named `⚙ <workflow> · <target>`
   and carry the run's state: `⚙` working, `⚠` your turn, `✓` done — only once every pane
   in the tab is — and `✗` stopped. Panes are named for what is in them: the model for
   parallel variants (`opus`, `sonnet`), the step's name when it runs alone. A toast tells
   you when a run is done or needs you.
6. `plan` and `architecture` end in a menu, which takes over the whole pane while it is
   open and hands it back afterwards. `prefix+u` picks up any run with unfinished steps.

The same operations are available without opening UI, which is how an agent drives Collie:
see [CLI](cli.md).

## What a run does to your repository

A run that changes code never works in the checkout you started it from. `implement` — and
`plan` or `architecture` once you let them chain into it — resolves the branch it is about
to build and gets a **worktree** of its own on that branch, opened through herdr, so it
arrives as its own workspace with its own tabs. Two runs can therefore build two branches
at once without sharing a working tree, an index, or a stash stack.

Which branch it is:

- work described in words, a plan directory or a Linear issue → a new branch named after
  the run, cut from `origin/HEAD`;
- a fix round on a review → the branch that was reviewed (a merge request's source branch,
  the head of a `branch:a...b` diff, or the branch the reviewed tree was on), so a merge
  request is updated rather than replaced;
- `collie run start implement --input branch=<name>` → that branch, whatever the above
  would have said.

The checkout lives under herdr's own worktree directory (`~/.herdr/worktrees/<repo>/<branch>`),
and the run's log says which one it got. It is a fresh checkout, so the first thing the
implementer does there is install the project's dependencies. Where herdr cannot give the
run a worktree, the run does not start and says which branch it could not be given one
for: working in the directory you started it from is what two runs sharing a checkout —
and a stash stack — looks like, which is the thing this exists to prevent.

The worktree outlives the merge request: it is still there when the run ends, so you can
look at what it built. It is removed only once **settled** — the tree is clean, it holds
no commit that is not on the remote already, nothing is working in it or could be resumed
in it, and its merge request is merged or closed (or its remote branch is gone). Pruning happens when Collie is already awake: at every run start —
which never touches the checkout that run is about to work in — and every few minutes
while a Control Plane is open, including for the worktree whose own board you are looking
at, which closes with it. The board says both what went and what is being held on to, with
the reason:

```
Worktrees
  ♻ removed add-a-picker · merged in !14
  kept fix-the-parser · 2 commit(s) unpushed
```

Nothing is ever removed with a force flag, and a checkout you made yourself is never
touched — only worktrees a run recorded as Collie's own are candidates. Removal goes
through herdr, so if you closed a worktree's workspace it is opened again to be removed
rather than deleted behind herdr's back. If git refuses to drop a checkout, that refusal
stands and the board says so in git's words; if it drops the checkout but will not delete
the branch, the board tells you which branch is left.

## The Control Plane

One tab per workspace, labelled `🐕 Collie`, created by the first run and reused by every
run after it, and moved to the front of the workspace each time so it is always
`prefix+1`. A tab still open under an older name is renamed in place rather than joined by
a second one. It is a board, not an engine: it watches the run directories and the register
of live agents and draws what it finds, so closing it loses nothing — the next run opens it
again. It is the only pane Collie keeps open; the run itself is driven by a Driver with no
pane at all.

It is an application (ADR-0005): a nav rail over Runs, History, Workflows and Settings,
the list, a detail panel beside it — or as a full-width overlay when the pane is too narrow
for two columns — and the keys along the bottom. Click a row to select it, and the row and
the footer both offer what that row can be asked for. Mouse reporting is on only while the
pane has focus, so clicking another pane gives you your terminal's own text selection back
immediately.

The **Selection** is one row, wherever the mouse or the keyboard cursor put it, and every
action applies to it. It is held by the row's id, not its position: the list re-sorts every
refresh, and a run finishing under the cursor leaves the row that took its place selected.

```
🐕 collie  [Runs] History Workflows Settings
┌─Runs─────────────────────────────────────────────┐┌─Detail──────────────┐
│  1 Implementer  working · implement-add-a-picker ││Implement · a-picker │
│❯ ⚙ Implement · add-a-picker  fix · iteration 3/5 ││fix · iteration 3/5  │
│  ✓ Review · !2367            done  [l log]       ││implement-2026...    │
│  ⚠ Review · worktree         abandoned           ││                     │
└──────────────────────────────────────────────────┘└─────────────────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│l log · k stop · 1-9 focus an agent · p run a workflow · u resume · ...   │
└──────────────────────────────────────────────────────────────────────────┘
```

A pane with no terminal, a dumb `TERM` or one too narrow to render in prints the
one-screen text view instead, with one line saying why, and keeps the keys it always had.

### Views

**Runs** is this session's live work: agents, active runs, finished runs. **History** is
every finished run of this checkout whatever session it came from — where "review !123
again next week" comes from once the original run is gone. **Workflows** is every workflow
and persona with its layer, inputs, decisions and whatever validation says is wrong with
it. **Settings** is the defaults and remembered values in `config.json`, and whether the
harness is trusted here. None of them is read until it is first shown.

**Agents** is every agent of this session's runs that herdr still has — reviewers and
synthesizers as well as the implementer and the planner. The ones a hand-off can name are
called by their role and come first; the rest are called by their step and model. A role is
a label, not a filter.

Under the directory, a line appears when this installation is behind its remote, naming
how far behind it is and the command that clears it:

```
Collie is 3 commits behind its remote — `collie upgrade`
```

Nothing else happens: it is shown, never sent, because being a few commits behind is not
worth interrupting anyone for. The count is read from the refs this machine already has,
so the board never waits on a remote; a fetch runs behind it every few minutes and the
next redraw shows what that brought. The line is absent entirely when this installation is
not a checkout or its branch has no upstream. `collie doctor` reports the same thing, and
fetches before it answers because you are waiting on it.

**Runs** is what is going on now. A run whose Driver died — no agent of its own left and
nothing written for a minute — moves to **Finished** as `⚠ abandoned` rather than sitting
there pretending to work.

### The detail panel

Fills with the Selection: a run's inputs, steps, hand-offs, each step's Output and — the
point of it — the review it wrote, readable without splitting a pane. A run whose target is
a merge request shows that above the review: state, pipeline, approvals, unresolved
threads, and what has moved since this review finished. A workflow shows its steps, inputs,
decisions and validation problems.

### Keys

Keys are offered only when there is something to act on, and a row's own actions are on the
line under it as buttons. Movement is the arrows and not `j`/`k`: `k` is the stop key, and a
destructive key that sometimes means "up" is worse than no vim binding.

| Key     | What it does                                                                    |
| ------- | ------------------------------------------------------------------------------- |
| `↑↓`    | Move the Selection                                                              |
| `Tab`   | Move between views                                                              |
| `1`–`9` | Focus that agent's pane                                                         |
| `p`     | Run a workflow — the same launch flow as `prefix+f`, inline in this tab         |
| `u`     | Resume a run with unfinished steps                                              |
| `f`     | Fork a workflow or persona                                                      |
| `s`     | Hand the **selected** run's review to a live implementer                        |
| `l`     | Open the selected run's `runner.log` in a temporary pane                        |
| `t`     | Tail that log inside the detail panel                                           |
| `m`     | Read another page of a review the panel cut short                               |
| `x`     | Start a fix run from what the selected review left open                         |
| `a`     | Review the selected run's target again                                          |
| `o`     | Post the selected review to its merge request                                   |
| `w`     | Open the selected merge request in a browser                                    |
| `c`     | Copy that merge request's URL                                                   |
| `k`     | Stop the selected run — closing a pane no longer does that, because it has none |
| `/`     | Filter the list, and say how much is left                                       |
| `R`     | Re-read what is on screen, and the one merge request behind it                  |
| `q`     | Close the tab                                                                   |

`＋ New run` in the nav does what `p` does.

### Questions

When a run asks you something, its options appear indented under its row and the keys
become that question's — `↑↓`, Enter, Esc, or just type where it wants text — and clicking
an option answers it. The question belongs to that run, so a second run waiting on one is
answered by selecting it rather than waiting its turn. The question lives in the run's
directory, so closing this tab, reopening it, or resuming later shows you the same question
again rather than losing it. The Driver toasts and brings the tab to the front before it
asks, so a question is never left unseen in a tab you are not looking at.

The board shows this session's work and nothing else: one herdr session, one workspace, one
repo. Another workspace's runs never appear, even for the same repo, and a workspace id
that herdr has since given to a different workspace is caught by its label.

## Actions

| Action               | What it does                                                           |
| -------------------- | ---------------------------------------------------------------------- |
| `cego.collie.pick`   | Popup picker of workflows; infers inputs, asks for the rest, then runs |
| `cego.collie.resume` | Popup picker of runs with unfinished steps; finished steps are skipped |
| `cego.collie.fork`   | Copy a workflow or persona into your layer or this project's           |

Each action opens the `picker` popup, because that is where a terminal is. The run itself
is not a pane: the picker starts a detached Driver that outlives it and writes what it is
doing into the run directory, and the Control Plane is what renders that. A run therefore
survives the picker closing, the Control Plane closing, and the terminal being detached.

## Resuming a run

`prefix+u`, or `collie run resume <id>`, starts a fresh Driver for a run and skips the
steps that already finished. A step is finished when its `output:` file exists, so an
agent that went quiet without writing one is restarted rather than assumed done. The
Driver claims the run atomically, so `resume` refuses to start a second Driver for a run
something is already driving.

Esc at a Choice leaves the step unfinished on purpose, so `resume` finds the run again.

## Hand-offs between runs

Runs in the same **session** — one herdr session, one workspace, one repo — know about
each other's long-lived agents, and hand work over rather than starting a second one. There
is only ever one implementer and one planner per session.

**A review, to whoever can act on it.** After the synthesis, a standalone review's menu
offers exactly one of these, never both:

- **Send to implementer** — when an implementer is already working here. It is the first
  option, so Enter takes it: that agent is prompted with `review.md` and the findings JSON
  and applies them as a fix round, `disputed` and all. Both runs record the hand-off. The
  `s` key on the Control Plane does the same thing for the newest review in the session.
- **Fix findings** — when none is. It chains `implement` with the review itself as the
  work source: `review.md` is the spec, the findings are the tickets, and the implementer
  works where the review was pointed — checking out the branch, or `glab mr checkout` for
  a merge request, so the fixes land on that MR's own branch and its `mr` step updates
  that merge request instead of opening a second one.

**A plan that changes under an implementer.** The planner keeps its tab after its run
ends. If you refine the plan, take a second opinion, or just talk to the planner while an
implementer is building from that plan, the Driver sends it the diff of `plan/` and the
planner's own `changelog` — once per change — and asks it to reconcile.

**A decision the plan does not cover.** The implementer's prompt names the live planner's
agent and pane and tells it to ask there rather than stopping. With no planner live, the
same prompt tells it to stop and ask you.

## Reviewing someone else's merge request

An MR target carries its project, not just its iid: `mr:<host>/<group>/<project>!<iid>`.
Paste an MR URL and the project comes from the URL; type a bare `!42` and it comes from the
remote of the directory you are in. Every `glab` call the Driver makes — and every command
the review prompt hands the reviewers — then passes `--repo <host>/<group>/<project>`, so
no checkout of that project is needed: you can review and comment on a colleague's MR from
a group folder that is not a git repository at all.

Fixing one is a different matter. A fix round is an `implement` run, and a mutating run
works in a checkout of its own branch — which `herdr worktree` can only cut from the
repository it is asked in. So a review of a merge request in another project, or from a
directory that is not a checkout of it, will review and comment fine, but chaining into
`implement` from there stops and says so instead of building in the wrong repository.
Clone that project and start the fix round from there.

A step pointed at a merge request needs `glab` and `glab auth status --hostname <host>` for
that host. The "does this directory have a GitLab remote" check stays where it belongs, on
`implement`'s `mr` step, which is the one that pushes. In a directory that is not a
checkout there is no branch and no working tree to review, so the target menu is one entry
— **Type it…**.

## Your defaults

`config.json` in your config dir (the user layer), all keys optional:

```json
{
  "harness": "claude",
  "model": "opus",
  "effort": "high",
  "max_iterations": 5,
  "handoff_timeout_ms": 7200000,
  "quiet_ms": 600000,
  "notifications": { "run-done": false },
  "models": { "opencode": ["mycorp/local-model"] },
  "trust": "ask"
}
```

`models` adds models the harness adapter table does not already accept. An unknown harness,
model or effort fails validation before a single tab opens. See
[Authoring](authoring.md#harnesses-models-and-effort) for what each harness accepts.

`notifications` turns a kind of toast off. The kinds are `needs-you`, `decision-lost`,
`run-done`, `run-stuck`, `run-failed`, `step-stuck`, `output-unusable` and `mr-opened`, all
on by default. Every title carries the repo and the run, `request` is only ever used where
a human has to act, and the same question at the same step is announced once, even after a
Driver restart.

`quiet_ms` is how long a step's agent may produce nothing — no status change, no new output
in its pane — before it is nudged to unstick itself; it is nudged once more at double that
and given up on at triple, as blocked, with the pane left alone. Quiet is the signal, never
duration: a step that is still printing is never nudged, however long it runs. `0` waits
for as long as it takes.

## Trust: the first run in a repo

claude asks once per directory whether it may work there, and it asks inside its own tab,
where it is easy to miss. So the Driver asks you first, before a single tab opens:

```
claude has not worked in /home/mk/work/some-repo before
❯ Trust it now                  records it where the harness looks
  Let claude ask me in its tab  the run waits for you
```

**Trust it now** writes `hasTrustDialogAccepted` for that directory into `~/.claude.json`,
which is where claude keeps the answer to its own dialog. The previous file is copied to
`claude.json.bak` in the Collie state dir first, every other project and setting is carried
over as it was, and the new file is renamed into place with the old one's permissions, so
no reader ever sees it half-written. It is still a read-modify-write of a file claude owns:
if a claude session saves in the same instant, that save is the one that loses. It happens
once per directory, so the window is opened once.

`trust` in `config.json` answers the question in advance: `ask` (default), `auto`, or
`never` (leave the dialog to claude).

`auto` trusts every directory a run starts in, without asking. Be deliberate about it:
claude's question is "is this a project you created or one you trust?", and it says plainly
that claude will then read, edit and execute files there. `auto` is for a machine where
every repo you run workflows in is already one you would answer yes for.

If you do let claude ask, nothing breaks: `agent start` reports the agent blocked, which is
not a failure, so the Driver says which pane wants you, toasts, and waits. It cannot answer
for you — the dialog shuffles its options between runs, so there is no safe key to send.

## Troubleshooting

**A change to Collie has not taken effect.** Run `collie upgrade`, or `~/.collie/setup.sh`
again — either one. Both pull the checkout (`--ff-only`, and a pull they cannot do is
reported rather than forced) and both end in the same `prepare.sh`, so both bring the
plugin link, the runner and shim, the operator skill and the skills up to date. Every step
skips what is already in place, so re-running is cheap: an unchanged checkout is not even
rebuilt. The one difference is the keybindings, which `setup.sh` writes and nothing else
touches — if a binding you expect is missing, `setup.sh` is the one to run.

**Something is missing and you would rather not find out mid-run.** `collie doctor` checks
every prerequisite at once — herdr and its minimum version, the plugin link, the runner and
the shim's directory on PATH, a Node runtime, the skills and harnesses your workflows name,
whether this checkout is behind its remote, and whether `glab` is logged in — and prints the
command that fixes each. It exits non-zero when any check fails.

**A keybinding does nothing over SSH.** The three bindings use plain letters after the
prefix on purpose, because `alt` chords are not delivered reliably over SSH or through some
terminals. If you rebound one to a chord, that is the first thing to undo. Without any
binding, `herdr plugin action invoke cego.collie.pick` still works from a shell inside
herdr.

**A run shows as `⚠ abandoned`.** Its Driver is gone: no agent of its own is left and
nothing has been written for a minute. The run's audit trail is intact, so
`collie run resume <id>` starts a fresh Driver and skips the steps that finished.

**A run says another Driver already owns it.** The ownership claim in the run directory is
held by a live process. Stop it with `collie run stop <id>` before resuming.

**A workflow fails validation before any tab opens.** That is by design — unknown models,
missing personas and skills, malformed choices, and placeholders no declared input can
fill are all caught up front. `collie workflow check` reports the same problems without
starting a run, and names the file and the step.

**A skill is missing.** Skills are a prerequisite, like the harness binary. The error names
the skill and the command that installs it, and `collie upgrade` reinstalls the whole set.
See [Authoring](authoring.md#skills) for how a definition refers to one, and
[the skills](#the-skills) for where they come from.
