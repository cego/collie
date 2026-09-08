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
| `prefix+shift+c` | `cego.collie.board` — open this workspace's Control Plane       |

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
   open and hands it back afterwards. Launching asks nothing about it: a menu is asked when
   the run reaches it, so you decide with the work in front of you — `collie run start
--decide` is the way to pre-answer one for a run you will not be there for. `plan`'s
   menu also answers to the planner, so telling it "proceed" starts the implementation.
   `prefix+u` picks up any run with unfinished steps.

The same operations are available without opening UI, which is how an agent drives Collie:
see [CLI](cli.md).

## What a run does to your repository

A run that changes code never works in the checkout you started it from. `implement` — and
`plan` or `architecture` once you let them chain into it — resolves the branch it is about
to build and gets a **worktree** of its own on that branch. Two runs can therefore build
two branches at once without sharing a working tree, an index, or a stash stack.

Only the run's directory moves. Its tabs open in the workspace you started it from, so
everything about the task stays in one place — including when that workspace's own
directory is not a checkout of the repository at all, which is what `COLLIE_CWD` or
`collie --workspace <id>` is for. `--input workspace=new` asks herdr for the checkout
instead, which gives the run a workspace of its own the way it used to (ADR-0006).

Which branch it is:

- work described in words, a plan directory or a Linear issue → a new branch named after
  the run, cut from `origin/HEAD`;
- a fix round on a review → the branch that was reviewed (a merge request's source branch,
  the head of a `branch:a...b` diff, or the branch the reviewed tree was on), so a merge
  request is updated rather than replaced;
- `collie run start implement --input branch=<name>` → that branch, whatever the above
  would have said.

The checkout lives under herdr's own worktree directory — `~/.herdr/worktrees/<repo>/<branch>`,
or whatever `[worktrees] directory` says in the `config.toml` herdr is reading, which
`HERDR_CONFIG_PATH` may move — so herdr's own "open worktree" UI still finds it; the run's
log says which one it got. A branch with a `/` in it nests, so `feature/foo` gets
`…/<repo>/feature/foo` and never shares a directory with a branch actually called
`feature-foo`. A branch that already has a checkout is given that one — git allows no
second worktree on a checked-out branch, and a fix round has to land where the reviewed
work already is. It is otherwise a fresh checkout, so the first thing the implementer does
there is install the project's dependencies. Where the run cannot be given a worktree, it
does not start and says which branch it could not be given one for, in git's own words:
working in the directory you started it from is what two runs sharing a checkout — and a
stash stack — looks like, which is the thing this exists to prevent.

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
touched — only worktrees a run recorded as Collie's own are candidates. Whoever made the
checkout takes it away: Collie's own with `git worktree remove` and then `git branch -d`,
and the finished run's tabs still holding a shell inside it are closed with it, since
nothing else would ever close them. A checkout herdr has a workspace open on goes through
herdr whoever made it — and if you closed that workspace it is opened again to be removed
rather than deleted behind herdr's back — so herdr never lists a checkout that is gone. If
git refuses to drop a checkout, that refusal stands and the board says so in git's words;
if it drops the checkout but will not delete the branch, the board tells you which branch
is left.

## The Control Plane

One tab per workspace, labelled `🐕 Collie`, created by the first run and reused by every
run after it, and moved to the front of the workspace each time so it is always
`prefix+1`. A tab still open under an older name is renamed in place rather than joined by
a second one. It is a board, not an engine: it watches the run directories and the register
of live agents and draws what it finds, so closing it loses nothing — the next run opens it
again. It is the only pane Collie keeps open; the run itself is driven by a Driver with no
pane at all.

`prefix+shift+c` reaches it from any pane in the workspace, opening it first when the
workspace has none yet — a name to press rather than a position to remember, for a
workspace whose runs all pre-date the tab or whose tab was closed. It finds or opens the
tab exactly as a run does, so pressing it can never leave a workspace with two.
(`prefix+c` is herdr's own `new_tab` and is left alone.)

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
│  1 Implementer  working · Simplify the picker    ││Implement · a-picker │
│❯ ⚙ Implement · add-a-picker  fix · 12m · iter 3/5││fix · 12m            │
│  ✓ Review · !2367            done  [l log]       ││implement-2026...    │
│  ⚠ Review · worktree         abandoned           ││                     │
└──────────────────────────────────────────────────┘└─────────────────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│l log · k stop · Enter go to it · t log tail · g all · p run · ? keys     │
└──────────────────────────────────────────────────────────────────────────┘
```

A run that started runs of its own has them under it, the way a run has its agents — a
[plan that spans repositories](workflows.md#plans-that-span-repositories) is one thing on
the board rather than several rows beside each other. The parent's own line says which
wave it is on and what it is waiting for, and Enter on a child goes to that child's run.

```
┌─Runs─────────────────────────────────────────────────────────────────────┐
│❯ ⚙ Plan · add-a-version-flag       wave 2/2 · waiting on cego/web        │
│    ✓ Implement · add-a-version-flag  done · …/g/api!12                   │
│    ⚙ Implement · add-a-version-flag  fix · 4m · iteration 2/5            │
│      1 Implementer  working · Fix the findings                           │
└──────────────────────────────────────────────────────────────────────────┘
```

A pane with no terminal, a dumb `TERM` or one too narrow to render in prints the
one-screen text view instead, with one line saying why, and keeps the keys it always had.

### What a run's tab says

A run's tab is `⚙ Implement · control-plane-glass · fix 3/5`: the workflow, what it is
pointed at, and the step it is on — with the round of the fix loop where that step has
looped, and nothing where it has not. While the run is waiting on you it reads
`⚠ … · asks you` instead of naming the step, and when the run is over it is just
`✓ Implement · control-plane-glass`. herdr clips what does not fit its sidebar; the wide
board carries the full text. Every tab of one run says the same thing, so the workspace's
sidebar row says which step the run is on whichever tab it is showing.

The glyph is the state of what is in that tab, not of the last step that ran: anything in
it herdr calls `working` is ⚙, anything `blocked` is ⚠, and with nothing working it is the
run's own state — ✓ once the run has finished, ⚙ while it has not, ✗ when it failed. It is
kept true by whoever is watching: the Driver on the status poll it already makes, and any
open Control Plane on the `agent list` it already reads, each writing only when the string
changed. So a review handed back to a live implementer, or a finished run's agent you
prompt yourself, goes back to ⚙ without anyone renaming anything. With no Driver and no
Control Plane open, nothing reconciles — herdr's own agent-status column is the truth then.

### Views

**Runs** is this session's live work: each running run with the agents working for it
listed under it, then the runs that have finished, with theirs. **History** is
every finished run of this checkout whatever session it came from — where "review !123
again next week" comes from once the original run is gone. **Workflows** is every workflow
with its layer, inputs, decisions and whatever validation says is wrong with it —
workflows only, because a persona is instructions rather than something to run; `f` is
where personas are acted on. **Settings** is the defaults and remembered values in `config.json`, and whether the
harness is trusted here. None of them is read until it is first shown.

**Agents** is every agent of this session's runs that herdr still has — reviewers and
synthesizers as well as the implementer and the planner. Each hangs off its run, indented
and joined to it by `├`/`└`, so the run above says which run it belongs to and its own row
says what it is doing — a finished run included, because the implementer a hand-off names
outlives the run it was started for. An agent whose run is not on the board at all goes
under one dim `agents with no run here` header at the end. The ones a hand-off can name are called by
their role; the rest are called by their step and model. A role is a label, not a filter.

Each agent row says what that agent is doing right now, taken from the terminal title its
harness publishes — Claude Code puts the task it is on there — so progress is visible
without opening the pane. A harness that publishes no title leaves the row naming the run
instead. It costs nothing extra: the title comes back on the same `agent list` the statuses
do.

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

A run with a question for you is listed first, under a dim **Needs you** header, and the
footer says `N run(s) need you` whenever the Selection is somewhere else. A blocked run
costs the whole run's wall-clock and used to be visible only if its row happened to be the
Selection. The header is a label, not a row: the arrows step over it and nothing acts on
it. A pending question and nothing else counts: a run holding at a gate, or one whose agent
is answering a prompt in its own pane, says what it is waiting for in its detail column and
counts as running — there is nothing on this board to answer for either, and `1 need you`
used to send you to a row with no question under it.

An active row says which step is running and how long it has been going — `fix · 12m` —
so a stuck agent stands out from a slow one, and a run whose directory has not changed for
longer than `board_quiet_ms` adds `quiet for 9m`.

### Scope: this workspace, or the whole session

`g` switches what the **Runs** view is a board of. `local` is this session's own workspace —
one herdr session, one workspace, whatever checkouts its runs are working in — and another
workspace's runs never appear on it, even for the same repository: a workspace id herdr has
since given to a different workspace is caught by its label. `all` is every workspace of
this herdr session that Collie has a run, an agent or a history in, as one tree. The nav
says which scope is showing and the footer offers the other one by name.

```
🐕 collie  [Runs] History Workflows Settings  all · 3 workspace(s)
┌─Runs────────────────────────────────────────────────────────────────────────┐
│❯ ⚙ Implement · control-plane-glass   1 running · review · 2/5               │
│    ⚙ Implement                       review · 2m · iteration 2/5      2m    │
│      1 ├ Implementer                 blocked · Simplify the picker          │
│      2 └ Review · Opus               working · Review cego.collie           │
│                                                                             │
│  ⚠ Collie                            1 running · 1 need you · next          │
│    ⚠ Implement                       next — your turn                 4m    │
│                                                                             │
│  ⚙ Elsewhere · collie-mr-roles-wt    a workspace this session no longer has │
│    ⚙ Implement · mr-roles            review · 3/5 · quiet for 49h     2d    │
│                                                                             │
│    2 more workspace(s)               nothing of Collie's in them · Env · …  │
└─────────────────────────────────────────────────────────────────────────────┘
```

One **group row** per workspace, in herdr's own order, bold and selectable: herdr's label
with the status glyph stripped, then how many runs are going, how many need you, and the
leading run's step and iteration — enough to triage without expanding anything. Its glyph
is the worst of its runs (⚠ over ⚙ over whatever the newest finished one was).

Under it the active runs, then at most two finished ones so a quiet workspace says why it
is quiet, and under those that run's agents — all of them, because this board hides
nothing. A run is named by its **workflow alone**, because the group row already says what
the workspace is for; a run under **Elsewhere** keeps what it was pointed at, because that
group row names several checkouts. An agent keeps its own name in full, since the model is
what tells two variants of one step apart, and the `1`–`9` digits are numbered down the
whole tree, so a digit always names the row it is drawn on — the tenth agent onwards keeps
its row and loses its digit, as on the local board.

The workspaces with nothing of Collie's in them are named on one dim closing line rather
than given a row each: a herdr session is mostly those, so nothing is hidden and nothing is
in the way. Active runs recorded against a workspace this session no longer has — a closed
workspace, or another herdr session's — are grouped last under **Elsewhere**, named after
the checkout they were working in, because a run still going somewhere this board cannot
show is still news.

No herdr id is ever on screen: a workspace is its label, a run is its workflow, an agent is
its role. The ids stay inside the jump, which is the only thing that needs them. The tree's
indent is in the gutter beside the glyph, so title, detail and age start in the same column
at every depth, and no row changes height when the mouse crosses it — the only thing that
grows a row is the question the selected run is waiting on.

A board of the whole session costs a local one's herdr calls and no more: the same run scan
and the same one read of `agent list` and `workspace list`, which both boards are built from.

Starting a workflow, resuming, forking and hand-offs stay this session's, so `p`, `u`, `f`,
`s`, `x` and `a` — and the nav's `＋ New run`, which is what `p` is for the mouse — are
offered on a local board only: a run starts in _this_ workspace's checkout, and a fix round
or a second review would too, whichever row you press it on. `g local` is how you get back
to a board where they mean something. Answering a question, `k`, `l`, `w` and Enter work on
any run in the tree, and `k` closes the panes of that run's own agents wherever they are.

### The detail panel

Fills with the Selection: a run's inputs, steps, hand-offs, each step's Output and — the
point of it — the review it wrote, readable without splitting a pane. A run whose target is
a merge request shows that above the review: state, pipeline, approvals, unresolved
threads, and what has moved since this review finished. The Steps list carries a duration
per step: how long a finished one took, and how long the running one has been going. A
workflow shows its steps, inputs, decisions and validation problems.

Under the review is the **plan** the run is building from, where it has one: its own
`plan/` if it wrote one, else the plan directory it was started from. The `SPEC.md` text
is capped and paged with `m` exactly like the review, and each ticket is listed by its
first heading with `✓` when every checkbox in it is checked. That is what lets the work be
judged against its intent without leaving the tab.

The panel scrolls: `PgUp`/`PgDn` by a page and `⇧↑`/`⇧↓` by a line, with a scrollbar
whenever there is more in it than fits. The arrows stay the Selection's, because that is
what they have always been. The mouse wheel goes to whichever region the pointer is over
— the list or the panel — and a new Selection starts the panel at the top, because how
far the last one had been scrolled says nothing about this one.

The review and the plan spec are rendered a line at a time: headings in accent and bold,
list markers dim, fenced code dim, everything else plain. Line-level and no markdown
dependency — inline emphasis is left exactly as the agent wrote it, because rewriting the
text is how a review stops saying what it said.

### Keys

Keys are offered only when there is something to act on, and the Selection's own actions
are buttons on the footer's first line — clicking one does what the key does. While a
field has the keys — a run's question, a Settings value, the filter — the footer offers
that field's keys and nothing else, because every other key is being typed rather than
pressed. Nothing is
drawn under a row: every row is one line whatever is selected, so the list does not move
under the cursor. Movement is the arrows and not `j`/`k`: `k` is the stop key, and a
destructive key that sometimes means "up" is worse than no vim binding.

The footer holds the Selection's own actions as buttons, then one line of keys — whatever
the row and the detail panel offer, and `g <the other scope> · p run · ? keys · q close`
(`p run` on a local board only, like the key). Two wrapped lines of every global
was what made the important ones unreadable, so the rest of the table lives behind `?`: a
full-pane list of every key with what it does, in two columns so it fits a 24-row pane,
closed by any key. The meanings there are the short form; this table is the long one.

While a field has the keys — a question, the filter, a Settings value — the line says what
that field's keys do instead, and the Selection's own buttons go: `k` typed a `k` while
`[k stop]` stopped the run.

| Key           | What it does                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| `↑↓`          | Move the Selection                                                              |
| `⇧↑↓`         | Scroll the detail panel by a line                                               |
| `PgUp`/`PgDn` | Scroll the detail panel by a page                                               |
| `Tab`         | Move between views                                                              |
| `1`–`9`       | Focus that agent's pane                                                         |
| `Enter`       | Go to what the row points at — a workspace, a run's agent tab, an agent's pane  |
| `g`           | Scope, in the Runs view: this workspace ⇄ every workspace of this session       |
| `p`           | Run a workflow — the same launch flow as `prefix+f`, inline in this tab         |
| `u`           | Resume a run with unfinished steps                                              |
| `f`           | Fork a workflow or persona                                                      |
| `s`           | Hand the **selected** run's review to a live implementer                        |
| `l`           | Open the selected run's `runner.log` in a temporary pane                        |
| `t`           | Tail that log inside the detail panel                                           |
| `m`           | Read another page of a review or plan spec the panel cut short                  |
| `x`           | Start a fix run from what the selected review left open                         |
| `a`           | Review the selected run's target again                                          |
| `o`           | Post the selected review to its merge request                                   |
| `w`           | Open the selected merge request in a browser                                    |
| `c`           | Copy that merge request's URL                                                   |
| `k`           | Stop the selected run — closing a pane no longer does that, because it has none |
| `/`           | Filter the list, and say how much is left — a matching agent keeps its run      |
| `Esc`         | Clear the filter, from the list as well as from inside it                       |
| `R`           | Re-read what is on screen, and the one merge request behind it                  |
| `?`           | Every key with what it does, over the whole pane; any key closes it             |
| `q`           | Close the tab                                                                   |

`＋ New run` in the nav does what `p` does.

Anywhere the tab takes text — a question, the launch flow's filter, `/`, a Settings value —
a paste is accepted as typed text. The newline a copied line brings with it is dropped
rather than delivered, so a pasted value can be read before Enter sends it.

### Questions

When a run asks you something, its options appear in a region of their own, drawn over
the bottom of the list and above the footer — never taller than half the pane, so a long
menu shows the options around the cursor and says how many more there are. It covers the
list rather than taking rows from it, so no row moves and the list is the same size
whether or not anything is asking. The keys become that question's — `↑↓`, Enter, Esc, or just type where it wants text — and clicking
an option answers it. The question belongs to that run, so a second run waiting on one is
answered by selecting it rather than waiting its turn. The question lives in the run's
directory, so closing this tab, reopening it, or resuming later shows you the same question
again rather than losing it. The Driver toasts and brings the tab to the front before it
asks, so a question is never left unseen in a tab you are not looking at.

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

Runs in the same **session** — one herdr session, one workspace — know about
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
  "board_quiet_ms": 300000,
  "compact_at_tokens": 372000,
  "notifications": { "run-done": false },
  "models": { "opencode": ["mycorp/local-model"] },
  "trust": "ask",
  "permissions": "bypass",
  "scope": "local"
}
```

`scope` is which board a Control Plane opens on — `local`, this workspace, or `all`, every
workspace of this herdr session Collie has work in ([Scope](#scope-this-workspace-or-the-whole-session)).
`g` changes it for that tab and nothing remembers it, so this is the only place the answer
to "the way I use it" lives.

`models` adds models the harness adapter table does not already accept. An unknown harness,
model, effort, permissions mode or scope fails validation before a single tab opens. See
[Authoring](authoring.md#harnesses-models-and-effort) for what each harness accepts, and
[Permissions](#permissions-unattended-by-default) for what `permissions` decides.

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

`board_quiet_ms` is the same signal from the outside, and a separate number because it is
a different question: how long a running run's directory may go unchanged before the
Control Plane's row says `quiet for 9m`. Five minutes by default. Nothing is nudged and
nothing is given up on — it is shown, so a hung run is visible before you notice by
accident.

`compact_at_tokens` is where compaction between pieces of work kicks in — see
[Compaction between pieces of work](#compaction-between-pieces-of-work).

## Compaction between pieces of work

Collie reuses an agent across a Workflow's steps, a fix round's iterations and a hand-off
from another Run, so its context grows all day. Before it gives a reused agent the next
piece of work, Collie reads that harness's own current-context measure and, at or above
`compact_at_tokens`, asks it to compact natively and waits for the outcome before sending
anything.

One absolute number rather than a percentage: the four harnesses measure different
windows, and one number is what you can reason about. **372,000 tokens** by default.
`"compact_at_tokens": 0` turns the feature off; anything else has to be a whole number of
tokens above zero, and a value that is not is refused where it is written and fails a step
that would launch an agent rather than falling back to the default. There are no workflow,
step or per-harness overrides, and the five-minute wait below is fixed.

This is the harnesses' own compaction, asked for through their own official interfaces,
and their automatic compaction is left switched on. A harness that compacts before
Collie's threshold has already done the job; Collie's threshold is an extra floor, not a
replacement.

What a launch installs, per harness, into that agent's own control directory — never
into your `~/.pi` or `~/.claude`:

| Harness     | Verified against | What it installs, and what reads the context                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi          | 0.85.1           | An extension passed with `-e`. `ctx.getContextUsage()` is the estimate Pi's own compaction and footer use, and `ctx.compact`'s per-request callbacks are the outcome.                                                                                                                                                                              |
| Claude Code | 2.1.263          | A settings file passed with `--settings`, which is _additional_ settings. Its status line reports `context_window` — input plus output, cache folded into the input total exactly once — and its `PreCompact`/`PostCompact` hooks are the lifecycle — the request's token reaches `PreCompact` only, so the completion is the one that follows it. |
| Codex       | 0.153.4          | An App Server of its own on a loopback port, with the ordinary TUI pointed at it by `--remote`. `thread/tokenUsage/updated`'s `last.totalTokens` is the context its own indicator shows, `thread/compact/start` is the request, and the compaction's own turn is the outcome.                                                                      |
| OpenCode    | 1.18.9+          | The ordinary TUI hosting its own loopback server, on a session Collie created for it. The latest assistant message's tokens are the accounting OpenCode's own overflow predicate reads, `POST /session/{id}/summarize` is the request, and the compaction's own message is the outcome.                                                            |

Two things to know about the Claude one. It borrows your status line, so it prints the
context percentage there and Claude stops showing most of its own footer hints; if that
is not a trade you want, `"compact_at_tokens": 0`. And Claude has no documented
compact-failed hook, so a compaction of its that fails is an unresolved outcome — the
last row of the table above — rather than a confirmed failure. Collie will not call a
missing `PostCompact` a failure it did not see.

Claude's compaction also has no request id of its own, so Collie puts a token in
`/compact`'s instructions and reads it back out of `PreCompact`, which is the only hook
that carries them — a `PostCompact` payload is its trigger and the summary it produced.
So a compaction of Collie's own is known by its start, and what completes it is the first
manual completion that follows on the same session, the way Codex's and OpenCode's are
told by what was not there before. An automatic compaction of Claude's is a different
trigger, and your own `/compact` in the pane starts with a `PreCompact` of yours, which
leaves Collie's attempt unresolved rather than letting it take your completion.

Codex is one server per agent, and that is load-bearing rather than tidy. On a shared
server `thread/loaded/list` answers with every agent's thread and nothing in the protocol
says which is whose, so an endpoint that has two threads on it is refused rather than
guessed at. `thread/compact/start` carries no request id either, so Collie records which
compactions the thread already had before it asked, and only one that was not there
before can be its own. That compaction runs as a turn, so the turn's status —
`completed`, or `failed`/`interrupted` — is Codex's own answer rather than an inference
from an idle pane.

Each Codex agent's server is detached, so it outlives the Run that launched the agent and
is still there for a hand-off. The next launch puts down the endpoint of any agent herdr
no longer has, which is also what stops the control directories accumulating.

OpenCode needed the opposite trick. Its servers do not isolate sessions at all — every
one answers with every session in the project, and its "which sessions are active"
endpoints are empty unless a session is mid-turn — so nothing in the API could tell two
agents in one directory apart. So Collie creates the session itself at launch, on a
server that lives just long enough to make it, and hands it to the agent with
`--session`. Identity is then Collie's own rather than something to infer. A 200 from
summarize is the handler's own `true` after its loop and says nothing about what the loop
did, so success is the compaction's own message appearing; that message's error state —
including a context too large to compact — is the confirmed failure. And a sample taken
before a compaction is dropped rather than reused: the agent's last real message then
describes a context that no longer exists.

What happens at a boundary:

| What Collie finds                                                                | What it does                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `compact_at_tokens` is `0`                                                       | Sends the work.                                                     |
| A freshly launched agent's first work                                            | Sends it. There is nothing behind it to compact.                    |
| A usable sample under the threshold                                              | Sends the work.                                                     |
| A usable sample at or above it                                                   | Asks the harness to compact, then sends the work once it completes. |
| No usable sample — the harness has not measured this context, or the read failed | Warns, sends the work, and asks for no compaction from a guess.     |
| The harness confirms the compaction failed                                       | Warns and sends the work anyway.                                    |
| Five minutes with neither a completion nor a failure                             | Stops the Run without sending the work.                             |

The last row is the one to know about. An acknowledgement, an idle pane, an unrelated
compaction and a dropped connection all establish nothing, so Collie will not call the
attempt over — and a timeout is not proof that the agent stopped compacting either.
So it does not retry, does not touch the agent, and does not replay the work: the step
stops `blocked` with the reason, you get a `needs-you` toast, and the row on the board
says it needs you. Nothing will send that agent work while the attempt is still in the
air, `collie run resume` included — a resume finds the attempt's five minutes long spent
and stops again on the spot.

So look at the pane, and decide. If the compaction did finish and the harness simply
never said so — Claude has no compact-failed hook, so a `PostCompact` that never arrives
is unresolved for ever — the attempt is released by deleting that agent's control
directory, `<state>/compaction/<agent>/`, where `<state>` is
`$(herdr plugin state-dir cego.collie)`. Collie reads a missing record as an agent it
does not manage, so the next boundary measures the agent again from scratch. Killing the
agent works too: whatever replaces it is a new agent with controls of its own.

Only newly launched agents are managed. An agent that was already running before you
turned this on keeps working exactly as it did — there is no migration, retrofit or
restart flow, and there is not going to be one.

Why each harness is wired the way it is, and which of the plan's assumptions the
installed releases turned out not to support:
[ADR-0007](adr/0007-compact-a-reused-agent-at-a-work-boundary.md).

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

## Permissions: unattended by default

Most harnesses ask before running a tool call they have no rule for, and they ask in the
agent's own pane — the one place a Run nobody is watching cannot answer. So Collie decides
instead: agents start with their harness's unattended switch, and `permissions` in
`config.json` says so. (pi is the exception: it has no tool-approval prompt, so both values
start it the same way.)

| Value     | What a Run does                                                                        |
| --------- | -------------------------------------------------------------------------------------- |
| `bypass`  | Default. Each agent is started with its harness's unattended switch, where it has one. |
| `harness` | No switch. A harness that prompts does so in its own pane, and the Run waits.          |

Know what `bypass` buys: the agents run commands, edit files and install things without
asking, inside the checkout the Run is working in. There is no sandbox. `implement` is the
only workflow Collie gives a checkout of its own, so its agents work in a worktree, on a
branch, and everything they do is reviewed before it becomes a merge request. Every other
workflow — `plan`, `review`, a standalone `architecture` — runs its agents **in the
checkout you started them from**, with your uncommitted work in it and neither of those
fences in the way. That is the case to weigh before leaving the default on.

Set `permissions: harness` in Settings if you would rather answer the prompts yourself, or
`permissions: harness` on a single step (see
[authoring](authoring.md#harnesses-models-and-effort)) for one that should ask.

An unknown value is refused: Settings will not write it, a run reading one from
`config.json` fails before a tab opens, and an agent is never started with a mode Collie
cannot resolve — the fallback would be `bypass`, so it fails instead. A file hand-edited
into nonsense still opens in Settings, which is where you would put it right.

Trust is unaffected and still answered first: it decides whether the harness will work in
the directory at all, and permissions only decide what it asks about once it does.

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

**The glyph says ✓ but the agent is working.** Nothing was watching that tab: the glyph is
reconciled by the run's Driver while it lives and by a Control Plane that can see the run,
and a run whose Driver has finished — an agent you prompted yourself, or a review handed to
an implementer whose own run is over — has neither. A board sees its own workspace's runs
at the `local` scope and every workspace's at `all`, so open the Control Plane in that
run's workspace (`prefix+shift+c`), or any board and press `g`, and it is corrected within
a tick. Otherwise read herdr's own agent-status column in the sidebar, which is always the
truth.

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
