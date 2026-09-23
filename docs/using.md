# Using Collie

This is the operator's guide: how to install Collie, start a run from inside herdr, read
the Control Plane, answer what a run asks you, and pick up where you left off. For the
vocabulary — Run, operation, host, Choice, Hand-off — see [`CONTEXT.md`](../CONTEXT.md).

## Install

One command, safe to re-run:

```sh
git clone git@github.com:cego/collie.git ~/.collie && ~/.collie/setup.sh
```

`setup.sh` does its own work — clone the checkout or pull it, add the four keybindings
below to `~/.config/herdr/config.toml` if they are missing, configure Claude Code's status
line unless you have one of your own, reload a running herdr — and calls `prepare.sh` for
everything else. That is the one routine that prepares a
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

1. `COLLIE_TOKEN`, if you set it — a token that can read the repository:

   ```sh
   COLLIE_TOKEN=ghp_… ~/.collie/setup.sh
   ```

2. The login the host's own CLI already holds. For a GitHub release that is
   `gh auth token --hostname <host>`, and for a GitLab one `glab config get token --host
<host>`. Which of the two it asks comes from the release URL: GitLab download paths
   carry `/-/releases/`, GitHub's carry `/releases/download/`, so a self-hosted instance of
   either is recognised by its shape rather than its hostname. If you have run
   `gh auth login`, the install needs nothing else from you.

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

### Optional integrations

Two things a run can reach for that no install can set up for you, because both are a
login of yours. Neither is needed by the bundled `implement` and `review`, so `collie doctor`
reports them without failing, and a run that needs one is refused up front with the fix
rather than failing hours in.

| Integration | Who needs it                                                          | How to set it up                                                                                                           |
| ----------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Helle       | `renovate`, or any forked workflow with `waits: helle`                | `HELLE_API_URL=<url>` and `HELLE_API_TOKEN=<token>` in `~/.config/helle/env`, the file the Helle MCP wrapper sources       |
| Linear MCP  | `plan`'s "Offload to Linear"; `implement` given a Linear issue or URL | `claude mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp`, then log in when Claude Code asks |

Doctor tells the two failure modes apart. Not set up at all is a note under a `✓`, with
the command above. Set up and not working is a `!`: a credentials file missing one of its
lines, a token Helle answers 401 to, a host that does not answer, a `.claude.json` that is
not valid JSON. Each names the file to look in. `collie run start` asks the same two
questions for the workflow it is about to run and refuses with that detail when the answer
is no — a Run that would only find out at its merge step is not started.

### Environment variables

| Variable              | Contract                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `COLLIE_DIR`          | Checkout used by `setup.sh` when it is run outside a checkout; defaults to `~/.collie`.                                                      |
| `COLLIE_REPO`         | Git URL cloned by `setup.sh`.                                                                                                                |
| `COLLIE_TOKEN`        | Token used to download a release asset. Optional where `glab` or `gh` is already logged in to the release host.                              |
| `COLLIE_BIN_DIR`      | Where `install.sh` writes the `collie` on your PATH; defaults to `~/.local/bin`. `collie doctor` looks there for a shim that is not on PATH. |
| `CLAUDE_SKILLS_DIR`   | Claude Code's skill store, where `prepare.sh` links the operator skill beside `~/.agents/skills`; defaults to `~/.claude/skills`.            |
| `COLLIE_RELEASE_BASE` | Base URL from which `install.sh` downloads `collie-<os>-<arch>`.                                                                             |
| `COLLIE_MODE`         | Internal picker mode passed from a herdr action to its picker pane.                                                                          |
| `COLLIE_CWD`          | Working directory passed to picker and agent processes; also re-roots a CLI run.                                                             |
| `COLLIE_HOST`         | Host executable for development and tests: one executable path, or a JSON array containing the executable and arguments.                     |
| `GITLAB_USER_LOGIN`   | Who a generated branch is namespaced under. Unset, Collie asks `glab` who you are for this checkout's host.                                  |
| `HELLE_ENV_FILE`      | Where Helle credentials are read from; defaults to `~/.config/helle/env`. See [Optional integrations](#optional-integrations).               |

`COLLIE_MODE` is a process-to-process contract set by Collie; you do not set it yourself.

### Keybindings

`setup.sh` adds these if they are missing (`prefix` is `ctrl+b` by default; edit them in
`config.toml` afterwards). Plain letters on purpose: `alt` chords after the prefix are not
delivered reliably over SSH or through some terminals, and herdr's own config notes the
same.

| Key              | Action                                                         |
| ---------------- | -------------------------------------------------------------- |
| `prefix+f`       | `cego.collie.pick` — run a workflow                            |
| `prefix+u`       | `cego.collie.resume` — pick a run that is still going back up  |
| —                | `cego.collie.continue` — continue a task with another workflow |
| `prefix+shift+f` | `cego.collie.fork` — copy a persona into your layer            |
| `prefix+shift+c` | `cego.collie.board` — open this Herd's Control Plane           |

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
5. The run's own tabs hold agents and nothing else: one tab per agent it starts, labelled
   with the agent's role — `implementer`, `reviewer` — in the order they started, each
   `cd`-ed into the checkout the run works in. An operation that reuses an agent opens
   nothing. The label carries no state: the run's card on the board says what it is doing,
   and herdr's own agent-status column says what each agent is.
6. `plan`, `architecture` and `review` end in a question — **What next?** — answered on the
   run's card, with `collie run answer`, or in chat. Launching asks nothing about it: a
   question is asked when the run reaches it, so you decide with the work in front of you.
   `prefix+u` asks the host to pick a run that is still going back up.

The same operations are available without opening UI, which is how an agent drives Collie:
see [CLI](cli.md).

### Tasks: one workspace per piece of work

Starting a workflow starts a **task**, and a task gets a herdr workspace of its own —
created and focused, so you land on the work. Everything the task takes stays there: the
plan's tabs, the implementation it chains into, the review of that, and any follow-up.
Starting fresh from inside a task workspace makes another one, because a fresh start is
always new work; unrelated tasks never accumulate beside each other.

To put more work into a task you already have, continue it rather than starting fresh:
the `cego.collie.continue` action, or `C` on the Control Plane. Inside the task's own
workspace that task is meant and nothing is asked. From anywhere else you pick from a list
of tasks. Nothing continues a task by accident — not a workflow with the same name, not a
workspace whose label looks similar, and renaming a task workspace by hand changes nothing
about what belongs to it.

Finished tasks keep their workspace, with their conversations and reviews in it, until you
close it yourself. Nothing is moved, renamed or cleaned up: workspaces and runs from
before this existed stay exactly where they are and belong to no task.

A task workspace groups work. It gives no file or branch isolation — that is what the
worktree below is for, and it is unchanged.

Stopping a run closes nothing in its workspace — the agents keep their panes — and the
workspace's own shell tab is never given to an agent, so closing an agent's pane never
leaves it empty. If herdr closes it anyway, the next agent the task starts reopens it on
that run's checkout, and every run of the task uses the new one from then on; a checkout
that has gone as well leaves the run parked, saying so, until you restore it or start
again.

### What a task workspace is called

The name is worked out, not asked for: `<Project or theme> | <what this work is>`, for
example `Collie | Per-task workspaces`. Collie reads the names you already have on your
own workspaces, tabs and panes, and where several of them already share a prefix for this
repository it uses that prefix, spelled the way you spell it — so a second task for the
same project reads as a sibling of the first. Where nothing matches, the project is named
from the repository and the title from the work itself. There is no naming prompt, no
alias list to maintain, and nothing remembered between herdr sessions: your live labels
are the vocabulary, read each time.

Those labels are data. They go to the namer as a list of what things are called, under a
prompt that says so, and what comes back is two short strings that can only become a
label — never a path, an agent name or a command.

With `--input workspace=new` on a fresh task herdr opens the workspace itself, on the
checkout, and it is opened under this name — so a task reads the same on that path as on
any other. A
workspace herdr reopens rather than creates keeps whatever it is already called.

A name is decided once, when the task is made. Continuing a task never renames it, and
neither does a replayed start. **Rename anything and Collie leaves it alone from then
on** — a task workspace, a run's tab, an agent's pane: once the label is not one Collie
wrote, Collie stops writing it, through every later update and every continuation.

Tabs and panes inside a task workspace do not repeat the task: the workspace already
says what the work is, so the tab spends its width on the workflow and the step —
`⚙ Implement · fix 3/5` — and a pane says only what its tab cannot. One repository of a
fan-out keeps its own name, because several of them share one task workspace.

Where the namer cannot be asked — no herdr session to account the call against, or no
`claude` that takes the flags the isolation depends on — the task is still named, from
your live prefix and the work's own short name. Starting work never waits on a name.

## What a run does to your repository

A run that changes code never works in the checkout you started it from. `implement` — and
`plan` or `architecture` once you let them chain into it — resolves the branch it is about
to build and gets a **worktree** of its own on that branch. Two runs can therefore build
two branches at once without sharing a working tree, an index, or a stash stack.

Only the run's directory moves. Its tabs open in its task's workspace, so everything about
the task stays in one place: a `plan` and the `implement` it chains into are one task in
one workspace, the implementation on its own worktree. A fresh task's workspace is opened
on the checkout its first run is given, not on the directory you launched from. The
worktree is cut from the checkout the run starts from, so starting one from a directory
that is not a git checkout — a folder of repositories, say — is refused, naming that
directory, before anything is made; `COLLIE_CWD`, `collie --workspace <id>` or
`--input workspace=/path/to/checkout` names the right one. `--input workspace=new` asks
herdr for the checkout instead, and the workspace herdr opens on it is the run's own —
or, for a fresh task, the task's (ADR-0006).

Which branch it is:

- work described in words, a plan directory or a Linear issue → a new branch
  `<your GitLab login>/<the task>`, cut from `origin/HEAD`. The login is
  `GITLAB_USER_LOGIN`, or whoever `glab` is logged in as; a run with neither does not
  start and says to log in;
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

### A run that roams across branches

`renovate` changes the repository too, but it does not build one branch — it moves across
every Renovate Bot branch it merges. So it gets a checkout of its own that is **detached**
at the repository's default branch as the remote has it, at
`~/.herdr/worktrees/<repo>/renovate`, and no branch is created or claimed for the run.
There is no `--input branch=` for it, and nothing it does binds a branch to its worktree:
it fetches and checks out each Renovate branch inside that one checkout and pushes with an
explicit refspec, so a Renovate branch that already has a checkout of yours is left where
it is and reported, never taken over.

`--input repository=<path>` says which local checkout to cut that worktree from; without it, the
one the run was started in. The repository has to be checked out locally already — cloning
from a URL is not something a run does. Two renovate runs on two repositories get two
checkouts, one per repository. A second one on the _same_ repository is refused rather
than handed the first's working tree. So are two repositories that share a name — the
path is `<repo>` as the directory is called, so two `api`s want the same one — and so is
anything else in the way, rather than being built over.

A refusal says only what is known: which repository git says owns the path, and which
run recorded it where a run record proves one did. Nothing is guessed, and neither the
checkout nor either repository is touched. Looking and creating happen under one lock
keyed by that path, so two runs starting at the same moment cannot both find it free.
The path is yours again once that run's checkout is removed or pruned; a resumed run
reuses only the checkout it recorded itself, and never claims a new one.

The worktree outlives the merge request: it is still there when the run ends, so you can
look at what it built. It is removed only once **settled** — the tree is clean, it holds
no commit that is not on the remote already, nothing is working in it or could be resumed
in it, and its merge request is merged or closed (or its remote branch is gone). A
`renovate` checkout has no branch to ask either question about, so a clean one nothing is
working in is settled, and there is no branch to delete with it. Pruning happens when Collie is already awake: at every run start —
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

**One board per herdr session**, in a workspace of Collie's own called the **Home**
([ADR-0009](adr/0009-the-collie-tab-is-the-herds.md)). One herdr session is one **Herd**,
and one Herd has one board: two boards would be two views disagreeing about the same Runs.
There is no per-workspace board and no view to switch to: one workspace's work is its own
cards on this one, and the search is what narrows to it. Your work stays where it is — a
Run still runs in the workspace it was started from, and so do its worktrees, its agents
and its hand-offs.

The Home is **owned by metadata, never by a label**: the workspace and the board's pane
carry a token naming this Herd, and Collie's record of which workspace that is counts only
while the token — or the recorded pane, still with the terminal it was recorded with —
proves it. Two workspaces claiming it, or a claim nothing proves, is a question Collie
refuses to answer for you: rather than draw a board it cannot say is this Herd's, the
shortcut prints why, names the candidates and gives you `collie home reconcile`. Nothing is
created because a token expired, and nothing is adopted because it looks right.

The Home is **one tab with two panes**: the board on the left at four sevenths of the
width, and [native chat](#talking-to-collie-about-the-flock) on the right at three. Both
are ordinary panes — herdr's own keys move between them and resize them, and reopening the
Home reopens only a pane that has actually gone, so a divider you dragged stays where you
put it.

It is a board, not an engine: it draws the Runs the host reports — the ones it is holding
and the ones an older Collie left, imported once — the register of live agents and the
steering journals, so closing it loses nothing — the next run opens it again. The run
itself is executed by the host, which has no pane at all.

`prefix+shift+c` reaches it from any pane in any workspace, making the Home first when
this Herd has none yet, and taking you there — a workspace switch as well as a tab focus.
What it opens is the whole Herd's board wherever you pressed it: there is one board, and
the search is the only thing that narrows it. (`prefix+c` is herdr's own `new_tab` and is
left alone.)

A `🐕 Collie` tab left over from when every workspace had one shows a single line saying
the board moved, and the key that goes there. Nothing else: no board and no chat. It is
marked as legacy, which is the only thing `collie home cleanup --confirm` will close, and
then only when it is alone in its tab — everything else is listed with the reason it was
kept.

```
collie home show                 what Collie thinks the Home is, and what proves it
collie home reconcile --adopt w7 that workspace is this Herd's Home
collie home reconcile --forget   forget the record; the next launch decides again
collie home cleanup --confirm    close the legacy panes that are alone in their tab
```

Because the Home has no checkout of its own, starting a run from it asks **which
workspace** the work is in first, resolves that workspace's directory — its worktree, else
its first pane's — and says on screen where the run will be rooted before asking for a
single Input. A workspace whose directory is empty, missing or Collie's own namespace is
listed with the reason it will not do.

It is an application ([ADR-0005](adr/0005-collie-tab-is-an-application.md)), and it is a
**board of Tasks, not a table of Runs**
([ADR-0013](adr/0013-the-board-is-cards-of-tasks.md)): one card per
[Task](../CONTEXT.md), whatever Runs that Task took. A header sentence, then four sections
that answer four questions in order — what needs you, what is working, what is waiting on
you, what finished. A decision beats liveness, liveness beats history, and history is split
by whether the work **landed**.

**Needs you** is one card per Task that has stopped for you: an open decision you answer
on the card, or an agent waiting for you in its own pane — a harness dialog herdr will not
answer, or a run that parked because its agent's pane would not take a prompt. The second kind has nothing to
answer under the card and says where to go instead (`Waiting for you in build-r7's pane.`);
Enter on the card gets you there. Either way the work has stopped, which is what the
section is for. **Working** is one card per Task something is
actually doing — a Run the host holds that has not settled, or an agent herdr still has: its name,
its project, one plain sentence about what is happening, one amber line when it has
drifted, the step glyphs, where it has got to, how many agents are on it and how long it
has been going. Silence past `board_quiet_ms` reads `…but silent for 14 minutes` and moves
nothing. **Waiting on you** is work that ended without landing, and that nobody has
asked you about: an implement that succeeded and whose merge request is open, a plan that
is ready to implement, a Run that failed, was stopped or was abandoned with a branch or a
merge request behind it and has neither been resumed nor disposed of. A Run that ended with
nothing to file — no branch, no merge request, no plan, no question — is finished, not
waiting: fifty such cards are not fifty obligations. Each card's first button is the one
action that ends its wait — Open MR, Implement now, Resume, Mark superseded — with Mark
merged and Mark abandoned beside it in the menu. The newest ending is at the top; anything
older than a week folds into one counted line, `▸ 9 older than a week`, and the header
counts the week's endings while the fold counts the rest. **Finished** is work that landed
— a disposition was recorded, the Run succeeded at a workflow that produces nothing to
land, such as a review, or it ended with nothing to file — as one line, `3 finished today,
1 failed`, until you click it open; anything older than a day is behind `older…`, which
reads it from this checkout's history rather than carding every Run Collie has ever kept.

Collie learns a merge by itself. In the background, every few minutes and never on a
redraw, it asks GitLab about each merge request in Waiting on you; one that merged gets its
`merged` disposition recorded as GitLab's word and its card moves to Finished. One that was
closed without merging only changes its card's sentence: closing can mean superseded as
easily as abandoned, and only you know which.

The header sentence counts the whole Herd, not what the search left: `One decision is
waiting on you. 4 working, 1 gone quiet. 3 waiting on you.` — the last count being this
week's endings, the older ones sitting behind the fold — amber while anything needs
you and muted otherwise. Beside it, a search field (`/`) matching a task's name, its project, its branch
and what its agents are called and are doing, and **New run**. At the left, the brand
signature — Luma and the lettering, drawn as a picture over the Kitty graphics protocol —
appears when every terminal attached to herdr paints such pictures (Ghostty, kitty,
WezTerm; not Alacritty); otherwise the plain `collie` wordmark stands there instead. herdr answers the protocol's handshake on its own, so the board reads the
attached clients' `TERM` instead, and draws no mark rather than a blank when unsure.

```
collie  One decision is waiting on you. 4 working, 1 gone quiet.   ⌕ find a task   + New run

NEEDS YOU
┌─────────────────────────────────────────┐
│◆ RUM sourcemap upload  frontend-core  9m│
│Waiting on your answer about the cap.    │
└─────────────────────────────────────────┘
WORKING · 2
┌─────────────────────────────────────────┐┌────────────────────────────────────┐
│● Strapi prod seeder        content   58m││● Docs run          collie       5h │
│Fixing the review findings, round 2 of 5.││Building, but silent for 3 hours.   │
│↯ editing src/ui/App.tsx, outside the    ││                                    │
│✓●○  review  2 agents                    ││●○○  build  1 agent                 │
└─────────────────────────────────────────┘└────────────────────────────────────┘
WAITING ON YOU · 1
┌─────────────────────────────────────────┐
│✓ Control plane redesign    collie    2h │
│Finished; mk/collie!65 is open.          │
│✓✓✓✓✓  done                              │
│ Open MR   ⋯                             │
└─────────────────────────────────────────┘
▸ 1 finished today
```

A held Task carries one more line under its sentence — `⏸ Held until 14:00.`, on your own
clock rather than UTC — and the drawer says who held it and why. See [Hold and release](cli.md#hold-and-release).

**A decision is answered on its own card**, with nothing to select first. A question's
options are buttons, the first one filled; clicking one answers that question and no
other, so one replaced while you were reading it cannot be answered by mistake. A question
with no options has a field instead: click it, type, and Enter sends. What you have
half-typed stays in the tab, per question, until you send it — nothing reaches the run
directory until then. A proposal card lists every action it would carry out, `✓ allowed
now` where the target's own authority already covers it and `? needs your yes` where it
does not, with the proposal's id and hash beside **Confirm** — your yes is consent to that
payload, and nothing else on the card can give it. **Decline** declines it. Either way the
card leaves Needs you and the header recounts.

A run holding at its [evidence gate](cli.md#outcomes) is a decision card too, and says
which verifications it would be held to. **Approve** takes the list as it stands, **Skip**
opens the merge request without checking any of it, and **Edit the list** opens the record
with the names to tick off — `Approve the list` holds the run to what is left, and nothing
left is Skip by another name, which the gate refuses. The answer goes on the record, so a
skipped gate is a decision somebody took rather than a check that quietly did not run.

The sentence is the step's own words where its workflow gives it a `summary`
(the module says what it is doing), and the step kind's own verb where it does not. A
step id never reaches it.

A glyph says where the Task is: ✓ done, ● working, ◆ waiting on you, ○ not yet, ✗ failed,
■ stopped. A card whose state is worth interrupting you for carries a coloured edge — amber
for a question or a gate, red for a proposal or a failure, purple for one that has gone
quiet. A [plan that spans repositories](workflows.md#plans-that-span-repositories) is one
card, whose sentence names the wave and which repository is next.

Two cards fit across at the comfortable density and three at the compact one (`density` in
[your defaults](#your-defaults)); a pane under 80 columns shows one. Mouse reporting is on
only while the pane has focus, so clicking another pane gives you your terminal's own text
selection back immediately.

**Click a card** and its whole record slides over the board as a drawer — intent, the steps
with their durations, the agents, the branch and merge request, and the latest card — with
`close` and Esc to dismiss it. It is an overlay: the board behind it keeps every other card
where it was, so reading one Task never costs you the overview.

**Point at a card** and, where its age was, `go to tab` and `⋯` appear; the card does not
move or grow. `⋯` opens that Task's menu, and so does a right-click anywhere on the card —
use `⋯` in a terminal that keeps the right button for its own menu. Clicking anywhere else
closes it, as does Esc, and the key beside each item does it from the keyboard:

|         |                    |                                     |
| ------- | ------------------ | ----------------------------------- |
| `enter` | Open record        | always                              |
| `g`     | Go to its tab      | always                              |
| `s`     | Steer…             | while something is still driving it |
| `w`     | Open merge request | when there is one                   |
| `u`     | Resume run         | failed or stopped                   |
| `x`     | Follow-up run      | finished                            |
| `k`     | Stop run           | working, quiet or waiting on you    |

Only what that Task can be asked for is listed: an item that would come back "this run has
already finished" is not offered at all. Nothing is offered on one board and withheld on
another — there is one board and one set of actions on a card — and no herdr id is on
screen anywhere: a Task is its name, a workspace is its project, an agent is its role.

The drawer's header carries the same as buttons, without the one that opens what is already
open, and adds **Mark merged** and **Mark abandoned** once the work is over — recorded
[beside the run's status, never over it](cli.md#what-became-of-the-work), with its merge request
as the reference where the board knows one. A Task with a decision open shows **Answer
above** instead, which closes the drawer to the card whose buttons answer it.

**Steer…** opens the record with the keyboard in the field at its foot; type and press
Enter, and Collie answers with a proposal on that Task's card. The field is not there for a
run nothing is driving.

Every action says what it did in one line at the foot of the board, which goes when you do
anything else.

A pane with no terminal, a dumb `TERM` or one too narrow to render in prints the
one-screen text view instead, with one line saying why: the same three sections, with the
same sentence on every line.

```sh
collie --json board   # the same model, for an agent reading the CLI
```

### What a run's tab says

A run's tabs are named for the agent in each — `implementer`, `reviewer` — and carry no
state glyph. What a run is doing, and whether it is waiting on you, is its card on the
board; what each agent is doing is herdr's own agent-status column in the sidebar.

### Workflows, Settings and what came before

`≡` at the header's right is everything that is not the board. **Workflows** is every
workflow with its layer, inputs, decisions and whatever validation says is wrong with it —
workflows only, because a persona is instructions rather than something to run; `f` is
where personas are acted on. **Settings** is the defaults and remembered values in
`config.json`, and whether the harness is trusted here. Each fills the pane, `close` or
Esc brings the board back exactly as you left it, and neither is read until it is first
opened.

Clicking a workflow runs it. Clicking a setting you may change opens a field on its own
row, beside the value it would replace: type the new one and press Enter, or Esc to leave
it. The field starts empty rather than holding the old value — these are short values, and
Enter on an empty field is what unsets one. `density` is a setting: `comfortable` draws two
cards across and `compact` three, and the board redraws as soon as it is written.

**What came before** is the foot of the expanded Finished section. `older…` reads this
checkout's earlier finished runs — every session that ran here, which is where "review
!123 again next week" comes from once the original run is gone — and pages them in ten at
a time, as lines rather than cards: they are a record, not work in hand. Nothing of it is
read until the link is pressed.

`Tab` moves the keyboard on: the board, the record over it, then `≡`, and round again.

### The record: Summary, Review, Plan, Cards, Log

Clicking a card opens that task's **record** over the right-hand side of the board — over
it, never instead of it, because reading one task must not cost the overview of every
other. `close` or Esc puts it away. Under the name and the buttons are five tabs, and one
is showing at a time:

- **Summary** — what it is for and where it has got to: the intent (its goal, and each
  constraint marked `¬`), the steps with a duration each, the live agents — each saying
  what it is doing right now, from the terminal title its harness publishes, so progress is
  visible without opening the pane — the branch, and the merge request behind it: state,
  pipeline, approvals, unresolved threads, and what has moved since this review finished.
  The newest card is at the bottom.
- **Review** — the review the run wrote, readable without splitting a pane and running
  `less`. It is what the record is opened for.
- **Plan** — the plan it is building from: its own `plan/` where it wrote one, else the plan
  directory it was started from. Each ticket is listed by its first heading, with `✓` when
  every checkbox in it is checked. That is what lets the work be judged against its intent
  without leaving the tab.
- **Cards** — the evidence: every card Collie wrote for this run, the drift nobody has
  settled, and what each message sent to its agents actually reached.
- **Log** — the end of a `log.txt` the run left in its directory, where it left one; a
  run that wrote none says so, because its agents' panes are its record. It is read only
  while this tab is showing it, because a log can be any size.

The review and the plan's spec are capped and paged: `… truncated` says so, and `m` reads
another cap of it. They are rendered a line at a time — headings in accent and bold, list
markers dim, fenced code dim, everything else plain. Line-level and no markdown dependency:
inline emphasis is left exactly as the agent wrote it, because rewriting the text is how a
review stops saying what it said.

The record scrolls with the wheel wherever the pointer is over it, and a new record — or a
new tab — starts at the top, because how far the last one had been scrolled says nothing
about this one.

At the bottom is one field: **say something about this run**. What you type there is a
[steer](steering.md) about that run and nothing else — it is written down, Collie is asked,
and what comes back is a proposal you confirm. The field is absent for a run that is
finished, failed or stopped: there is nothing left to say it to. What the send
actually reached shows up under **Cards**, as `→ implementer acknowledged`.

### Stopping, and stopping several

**Stop run** — from a card's menu, from the record, or `k` — does not reach the host
straight away. The card says `■ stopping…`, the foot of the pane says `Stopped <name>` with
an **Undo** button, and only when five seconds have passed is anything sent. Nothing is
signalled and nothing is written in the meantime, so Undo takes back a decision rather than
racing one, and a run that ended by itself inside those five seconds is left alone — the
board says it finished on its own. Closing the tab inside the grace is the same as undoing
it: nothing was sent.

**Shift-click** picks cards out. With two or more picked, a bar at the foot says
`N selected · stop all · clear`: `stop all` stops every one of them that has something to
stop, under the same grace and one toast for the lot. Picking is not opening — nothing is
asked for until you press something — and an ordinary click is about the one card you
clicked, so it drops the selection.

### What a card says

A card's header names what it is about: `slice · build · iteration 2 · abc1234 · try-it` —
the kind, the step, the iteration, the revision it was written against, and how
[significant](steering.md) it is. Then what was asked for, what changed, and the evidence:

- **verifications** are what somebody actually ran, bound to that revision: `bun test pass`.
  A `fail` is in the accent colour; `unstable` and `stale` are dim and say which.
- **claims** are what an agent said about its own work, always prefixed `claimed:` and
  never among the verifications. A claim is not a pass, and it never reads as one.
- **missing** is what nobody checked. It is drawn even when it is empty — `missing: nothing
was left unchecked` — because silently absent is exactly the reassurance a card exists to
  withhold.
- **look at** lines are copyable text, never something Collie will run for you.
- the **narrative** is last and dim, prefixed `Collie:`. It is prose a model wrote about its
  own work, and nothing about it changes a card's significance.

A card on the board says there is something here to see without your opening the record:
drift is one amber `↯` line in the task's own words, and a held task carries its `⏸` line
under the sentence. Nothing about any of this takes your focus — only a pending question
does that.

A report about a Run that had already finished when it was judged is shown as
`pending report (undelivered)`. It was never written to that Run's inbox: the Run is over,
and there is nothing there to act on it. A [follow-up run](workflows.md) is how you act on
one.

### Confirming a proposal on the board

There is no composer here and no mode to enter: talking to Collie is the pane beside this
one. What the board is for is the other half — **confirming**. A **proposal** is drawn as
soon as it arrives: what Collie understood, and
every action it would take, each marked `allowed now` where that Run's own authority already
grants it or `needs your yes` where it does not, with the proposal's id and hash. Enter
carries it out; Esc declines it. Those two keys are the only ones the proposal takes — a
human reading what they are being asked to consent to cannot stop a run by pressing `k` at
it. The yes names the id and the hash, so it is consent to that payload rather than to a
summary of it. `collie steer`, `collie confirm` and `collie decline` are the same thing on
the command line ([docs/cli.md](cli.md)). Nothing else can answer for you: chat may carry
out what you asked for, but no tool of its own confirms a proposal — a model cannot consent
to its own, however it asks.

### Keys

The board is a mouse-first surface: everything it does is a button, a card or a menu item,
and the keys are shortcuts for what is already on screen. There is no footer of keys —
`?` puts the whole list over the pane instead, and any key closes it again.

| Key   | What it does                                                  |
| ----- | ------------------------------------------------------------- |
| `Tab` | Move the keyboard on: the board, the record over it, then `≡` |
| `/`   | Search, and narrow all three sections as you type             |
| `Esc` | Close the record; with none open, clear the search            |
| `m`   | Read another page of a review or plan the record cut short    |
| `r`   | Re-read what is on screen, and the merge request behind it    |
| `?`   | Every key with what it does, over the whole pane              |
| `q`   | Close the tab                                                 |

A card's menu takes the key beside each of its items — the table
[above](#the-control-plane), and the second half of what `?` lists — and `Esc` closes it. A field takes its own keys and nothing
else, because every other key is being typed rather than pressed: an answer, a steer and a
Settings value send with Enter, the search hands the keys back and keeps what you typed,
and Esc leaves any of them — clearing the search, which is what it is for. A proposal takes
exactly two, Enter to carry it out and Esc to decline. The launch flow adds `↑↓` to move
and `ctrl+u` to clear the line.

Anywhere the tab takes text — an answer, the launch flow's filter, `/`, a Settings value —
a paste is accepted as typed text. The newline a copied line brings with it is dropped
rather than delivered, so a pasted value can be read before Enter sends it.

### Questions

A question is answered on its own card, and what you press goes to the host, which holds
the run waiting on it. That is what makes it durable: closing this tab, reopening it or
resuming the run later brings you the same question rather than losing it, and it is the
same question `collie run answer` and chat answer. A proposal is kept the same way, for
the same reason.

The board brings its tab to the front when a question arrives, so a question is never left
unseen in a tab you are not looking at — unless you have set
[`questions: notify`](#your-defaults), which leaves it on the board without moving you.
Nothing else moves you: a card, a correction and a proposal all arrive while you carry on.

What you have half-typed or half-chosen against a question is kept per run and per question
for as long as the tab is open, so moving between waiting runs costs nobody their answer.
It is dropped when that question is answered or replaced by a new one, and never written to
a run directory: an unsent answer is yours, not the run's.

## Talking to Collie about the flock

The Home's right-hand pane is an ordinary **Claude Code** session — or **Pi**, if you
choose it — with Collie's role and Collie's tools. It is focused when the Home opens, so
the next thing you type is a question: no mode to enter, no composer to find, and paste,
history, streaming and compaction are the harness's own, because they always were better
than anything Collie would have written.

Ask about the flock and you get an answer about the flock. Chat reads the whole Herd,
always: nothing on the board narrows what Collie may see. Where there are
more Runs than one answer carries, it says how many it left out rather than answering as
though that was all of them. A follow-up is understood — the conversation is the harness's
own session, and it is still there when you reopen the Home.

**Chat knows which card you have open.** Every message you send carries one line naming
the open card, attached as you send it and never when you click — so opening ten cards and
asking about none costs the conversation nothing, and closing the record ends it. "How is
it going?" or "stop it" with a card open is about that card: the run tools take the
selection when you name no run, and the answer opens by saying which run it was about, so
a selection you had forgotten is visible rather than silent. It is a fact chat is **told**,
never a filter Collie applies for you — the Herd-wide reads stay Herd-wide whatever is open
([ADR-0012](adr/0012-the-boards-selection-is-an-explicit-chat-input.md)). Under your own
prompt the same fact can be Claude Code's status line, `board selection: <task name>`,
configured by `setup.sh` if you have no status line of your own; `collie doctor` says which.

**Choosing a harness.** `claude` is the default, on an installation you have had for
months as much as a new one, and independently of the harness your Runs are on.

```sh
collie chat status
collie chat harness pi
```

`chat harness` is a **launch preference**. It never stops, replaces or summarises a
conversation that is running: `chat status` shows what is running and, separately, what is
chosen for next time. When Pi does open it opens on Pi's own history and fresh Herd state —
there is no handoff, no generated switch summary and no transcript conversion, and your
Claude conversation is still there when you choose Claude again.

**What chat can do.** Ask it to hold a run, answer a Choice, steer an agent, stop or resume
one, follow up a finished run, amend an Intent, start a workflow, fork a Workflow or a
Persona, change what every new Run begins with, close the panes an older release left, or
upgrade this installation — it has the same set the CLI and the board have, through the
same validation and the same executors.

Which of two things it does with one depends on **who wanted it**
([ADR-0011](adr/0011-the-conversation-is-a-native-harness.md)):

- **You asked for it, so it is done.** "Hold happytiger" holds it, and its card says so
  until you release it. Chat may do what you could do on the board yourself;
  pointing you at the UI for something it can plainly do is chat obstructing you. A hold
  is `collie_hold`; stopping, resuming, releasing, answering a question, steering an agent,
  following up a finished run and starting one are `collie_do`, and so are the board's
  decisions — saying yes or no to a proposal, and marking what became of finished work.
  Each says what it came to.
- **Collie wanted it, so it waits.** Drift the evaluator noticed, a correction it wants
  to send: the board draws the proposal, and you confirm it against its id and the hash of
  exactly those actions, or decline it and nothing changed. Chat has no such route: what it
  wants of its own accord it says in words, and only your yes turns it into a request.

What it cannot ask for of its own accord: reconciling a delivery nobody can account for,
verifying, and setting what a Run — or every Run — may do without asking. Those are yours.
That the rest is really there is a gate: `test/chat-parity.test.ts` walks the CLI's own
command tree and fails on a command with no conversational route, so the list cannot
quietly fall behind the CLI.

A yes is yours, and you can say it here. "Confirm it" settles the proposal against its id
and the hash of exactly those actions, as the board does; "no" declines it by id alone,
because a refusal consents to nothing. What chat cannot do is decide: it never settles one on its own judgement, and
nothing it reads in a Run's notes or an agent's output is you asking. There is no action
that confirms anything either, so a proposal can never carry its own yes. Everything it
does is recorded as `chat:`, a confirmation you asked for included — which matters because
the bridge runs inside the harness's pane and so has a terminal, and a terminal is what the
CLI reads as a person. The origin is stamped by the entrypoint, not inferred.

There is no shell there, no file access and no way to write a record. A run it names that
does not exist is refused rather than retargeted, and a run you did not name is not one it
may assume — if it is unsure which you meant, it asks. Starting a workflow names the
workspace it is for, so a launch asked for in the Home lands in the repository it is about,
and it needs no existing run.

`collie tools list` and `collie tools call` are the same contract from a terminal, and
the list says which of the nine only read. Four of them do not: reading the news settles
the items it hands over, the installation checks fetch this checkout's refs, proposing
appends to the journal, and `collie_hold` holds what you asked it to hold. A harness that
decides for itself what to run without asking is told the difference rather than left to
assume.

If the harness you chose is not installed, chat says so and stops there: the board and
every Run are untouched, and Collie does not quietly open the other one instead.

**Collie also speaks first.** When a run ends or blocks, asks you something, drifts from
its Intent past what Collie may correct, starts repeating itself, or claims to be finished
without being able to show it, Collie writes that down as news. Turn it off with
`"proactive": false` in `config.json`.

What it does **not** do is call a model to find that out. The board already recomputes
this to draw it, and a transition in it is the whole trigger; noticing nothing writes
nothing, so a board redrawing over unchanged state costs exactly nothing. Output arriving,
a commit, a step starting, a pane changing and time passing are not on the list, and never
were — a changing pane is not progress.

Several things happening at once is one batch, not one interruption each. It says how many
older items it left out, and those stay waiting rather than being replaced by a single
latest-status line.

**How it reaches the conversation depends on the harness, and `collie chat status` says
which:**

- **Pi** is pushed to — attempted, and not yet proven here. Collie's extension hands the
  batch to Pi's own queue as a custom message, delivered between turns, so it cannot
  overwrite a half-typed draft, interrupt a running turn, or be attributed to you. Whether
  that message actually surfaces has not been observed on this installation, so nothing is
  marked delivered because of it and Pi is still told on its next turn. Collie has no way
  to type into your editor and would not use one.
- **Claude** is told on its **next turn**, through the `collie_news` tool. Claude's custom
  channels are an organization opt-in; Collie will not auto-confirm that consent, will not
  fake a push, and will not switch you to Pi behind your back. That nothing reaches an
  idle Claude pane unasked is a row of the live probe, watched on both harnesses rather
  than inferred from a help page.

**Sent is not read.** An item stays waiting until the conversation has actually taken it,
and one whose send nobody can account for stays visibly uncertain rather than being
retried or quietly marked delivered. `collie chat status` counts both.

Speaking first buys it nothing: a proposal from a turn Collie started goes through exactly
the same authority path as one you typed. Who started the turn is not an input to what is
permitted.

## What a run is for, and whether it got there

Every row carries a second line when it has something to say on it: what the run has to
prove (its [outcome](cli.md#outcomes)), how many pieces of evidence are still missing,
what is identifiably in its way, what became of its work, and the one command that moves
it on. The detail panel opens on the same four, above why the run stopped.

That ordering is the point. A board that says what a run is _doing_ answers a question
nobody has; what a human wants to know is what it is for and whether it got there.

The pane clock is **liveness** — an agent that has written nothing for a while gets a
nudge. The journal is **progress**: `collie run metrics <id>` reads what was actually
produced, and a changing pane is not on that list. The one number a harness reports about
an agent, its context size, is read at each work boundary for the compaction decision and
written to the same journal then — so the "largest context sample" in `run metrics` is what
the harness said at a boundary, not an estimate from the pane.

A run that failed and whose work someone then finished by hand says both things at once —
`failed · merged cego/collie!43 by mk`. The status is not edited to tidy the row: what
happened and what came of it are two facts, and losing either is worse than a row that
carries both.

A filter narrows what is drawn and never what is supervised. Every workspace is walked on
every tick, whatever the board is showing.

## Actions

| Action               | What it does                                                            |
| -------------------- | ----------------------------------------------------------------------- |
| `cego.collie.pick`   | Popup picker of workflows; infers inputs, asks for the rest, then runs  |
| `cego.collie.resume` | Popup picker of runs still going; the host picks the chosen one back up |
| `cego.collie.fork`   | Copy a persona into your layer or this project's                        |

Each action opens the `picker` popup, because that is where a terminal is. The run itself
is not a pane: the picker hands it to the host, which outlives it, and the Control Plane
renders what the host reports. A run therefore
survives the picker closing, the Control Plane closing, and the terminal being detached.

### Why a run stopped

The detail panel of a run that stopped opens with **Stopped**: one line saying why — the
review loop out of iterations or making no progress, a blocking finding the implementer
disputed, a last fix whose own account did not hold up, a stop someone asked for, or work
the run parked itself — a pane that would not take a prompt, nothing approved to prove it,
a workspace that closed with its checkout gone — then which actions are safe right now. Where nothing recorded says why, it says that rather than guessing.

It is the same classification `collie run show` and `collie run wait --until attention`
return ([the CLI reference](cli.md#watch-a-run) has the codes), from the same function, so
the board and an agent driving the CLI cannot disagree. Reading it recovers nothing and
changes nothing: only `u` and `run resume` pick a run up again.

## Resuming a run

`prefix+u`, or `collie run resume <id>`, asks the host to pick a run up again. The host
re-enters the workflow's current code and reuses every Activity it has already finished, so
completed work and its Outputs are kept and never redone, a question still open is still
open, and an agent already launched is reattached to rather than started a second time. A
stop is cleared first; a run that parked on a pane is handed the same prompt by the same
agent; and a run whose module was missing and has been put back is registered again and
carried on, without restarting the host. On a run the engine is already working it changes
nothing.

A workflow edited in a way that changes its shape has no promise of a seamless resume, and
not every such edit can be detected: start a new run where one would not carry on. A run
an older Collie recorded is imported read-only and cannot be resumed; `collie run start`
begins the same work again.

## Hand-offs between runs

Runs in the same **session** — one herdr session, one workspace — know about
each other's long-lived agents. There is only ever one implementer and one planner per
session.

**A review, to whoever can act on it.** After the synthesis, `review` asks **What next?**:

- **Fix findings** — an implementer on this review's own run applies them as a fix round,
  `disputed` and all. It is offered once.
- **Fix findings in a full implement run** — starts `implement` with the review itself as
  the work source: `review.md` is the spec, the findings are the tickets, and the
  implementer works where the review was pointed — checking out the branch, or `glab mr
checkout` for a merge request, so the fixes land on that MR's own branch and its merge
  request is updated instead of a second one opened.
- **Post to MR** — only for a merge request target: the review is posted to it.
- **Don't post** — the run ends with its findings.

**A plan that changes under an implementer.** `implement` reads its tickets by name each
time it reaches its list, so what is already built is kept and a ticket added or edited
since is built as it reads now. It is not told about an edit while it is building: a
resume, or the replay after a restart, is when the list is read again.

**A decision the plan does not cover.** The implementer's prompt names the live planner's
agent and pane and tells it to ask there rather than stopping. With no planner live, the
same prompt tells it to stop and ask you. It asks for one authority: an answer in the
pane, or the answer written into the ticket and the pane saying only that — because an
implementer that builds a pane answer while the file says something wider believes it is
done.

## Reviewing someone else's merge request

An MR target carries its project, not just its iid: `mr:<host>/<group>/<project>!<iid>`.
Paste an MR URL and the project comes from the URL; type a bare `!42` and it comes from the
remote of the directory you are in. Every `glab` call the run makes — and every command
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
`implement`'s merge request, which is the one that pushes. In a directory that is not a
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
  "proactive": true,
  "models": { "opencode": ["mycorp/local-model"] },
  "trust": "auto",
  "permissions": "bypass",
  "scope": "local",
  "density": "comfortable",
  "questions": "focus",
  "chat_harness": "claude"
}
```

Three more keys are what a shipped workflow asks this installation rather than assuming:
`"gitlab": {"assignee": "<user>"}` is who a merge request is assigned to — whoever `glab`
is logged in as when it is unset — `"linear": {"team": "<team>"}` is the team `renovate`
files its checklist with, and `"renovate": {"logs": "<where and how>"}` is a sentence
naming where this installation keeps its application logs, for a stage deploy that has to
be debugged. Leave any of them out and the workflow asks, or works from what the pipeline
itself can tell it.

`chat_harness` is which native chat the Home opens with, `claude` or `pi`. It is
independent of `harness`, which is what runs your work, and it is a preference for the
**next** launch rather than a switch: see
[Talking to Collie](#talking-to-collie-about-the-flock).

`scope` is left over from the board of views and changes nothing you can see: the board is
the whole Herd's whichever workspace you opened it from, and the search is what narrows it.

`density` is how many cards the board fits across — `comfortable` for two, `compact` for
three. A pane under 80 columns shows one whatever this says.

`questions` is what happens when a run stops to ask you something. `focus`, the default,
brings that workspace's Collie tab to the front — the behavior every install has had.
`notify` leaves the question on the board, with its count, and simply does not move you:
it waits there until you go to it. Neither setting hides the question from the board or
stops you answering it.

`models` adds models the harness adapter table does not already accept. An unknown harness,
model, effort, permissions mode or scope fails validation before a single tab opens. See
[Authoring](authoring.md#harnesses-models-and-effort) for what each harness accepts, and
[Permissions](#permissions-unattended-by-default) for what `permissions` decides.

`max_iterations`, `handoff_timeout_ms`, `quiet_ms` and `notifications` are still read and
shown under Settings, but a run of a workflow module consults none of them: `implement`
carries its own ceiling of four review and fix rounds, there is no hand-off between runs
to time out, no quiet agent is nudged, and no toast is raised.

`board_quiet_ms` is how long a running run's directory may go unchanged before its card
reads `…but silent for 9m` and takes the quiet edge. Five minutes by default. Nothing is
nudged and nothing is given up on — it is shown, so a hung run is visible before you notice
by accident.

`compact_at_tokens` is where compaction between pieces of work kicks in — see
[Compaction between pieces of work](#compaction-between-pieces-of-work).

## Compaction between pieces of work

Collie reuses an agent across a Workflow's operations and a fix round's iterations, so
its context grows all day. Before it gives a reused agent the next
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

If a harness is too old for Collie's compaction controls, or its version cannot be
checked, the Run still starts without those controls and logs the reason. Native
compaction stays enabled. Optional telemetry support is not a prerequisite for doing work.

What a launch installs, per harness, into that agent's own control directory — never
into your `~/.pi` or `~/.claude`:

| Harness     | Verified against | What it installs, and what reads the context                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi          | 0.87.1           | An extension passed with `-e`. `ctx.getContextUsage()` is the estimate Pi's own compaction and footer use, and `ctx.compact`'s per-request callbacks are the outcome.                                                                                                                                                                              |
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
So it does not retry, does not touch the agent, and does not replay the work: the work
stops with the reason, and the board says it needs you. Nothing will send that agent work while the attempt is still in the
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

Starting a Run selects its directory; Collie does not ask you to approve that selection
again. By default, it writes `hasTrustDialogAccepted` for that directory into `~/.claude.json`,
which is where claude keeps the answer to its own dialog. The previous file is copied to
`claude.json.bak` in the Collie state dir first, every other project and setting is carried
over as it was, and the new file is renamed into place with the old one's permissions, so
no reader ever sees it half-written. It is still a read-modify-write of a file claude owns:
if a claude session saves in the same instant, that save is the one that loses. It happens
once per directory, so the window is opened once.

`trust` defaults to `auto`. `never` leaves trust to Claude's own dialog. The old `ask`
setting is accepted as `auto`; Collie's duplicate trust menu has been removed.

If you do let claude ask, nothing breaks: `agent start` reports the agent blocked, which is
not a failure, so the run says which pane wants you and waits. It cannot answer
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
asking, inside the checkout the Run is working in. There is no sandbox. `implement` and
`renovate` are the workflows Collie gives a checkout of their own, so their agents work in
a worktree rather than in yours, and what `implement` does is reviewed before it becomes a
merge request. Every other workflow — `plan`, `review`, a standalone `architecture` — runs its agents **in the
checkout you started them from**, with your uncommitted work in it and neither of those
fences in the way. That is the case to weigh before leaving the default on.

Set `permissions: harness` in Settings if you would rather answer the prompts yourself, or
`permissions: harness` on a single operation (see
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
command that fixes each. It exits non-zero when any check fails. Helle credentials and a
Linear MCP in Claude Code are reported too, as `!` when they are set up and not working, and
never fail it: see [Optional integrations](#optional-integrations). It also names the
workflows here: every one a user or project entry overrides — which is what a run in this
project would actually do — and any Markdown workflow an older Collie left in your layer,
which nothing reads now. Neither is edited: both are yours.

**A keybinding does nothing over SSH.** The bindings use plain letters after the
prefix on purpose, because `alt` chords are not delivered reliably over SSH or through some
terminals. If you rebound one to a chord, that is the first thing to undo. Without any
binding, `herdr plugin action invoke cego.collie.pick` still works from a shell inside
herdr.

**A card has been silent for hours.** Look at its agent's pane first: an agent at a harness
dialog is waiting on something only you can see. `collie run show <id>` says what the run
is waiting on, and one that parked on a pane that would not take a prompt says so —
`collie run resume <id>` then hands the same prompt to the same agent.

**A workflow fails validation before any tab opens.** That is by design — a module that
will not load, will not construct or will not compile is caught up front. `collie workflow check` reports the same problems
without starting a run, and names the file.

**A skill is missing.** Skills are a prerequisite, like the harness binary. The error names
the skill and the command that installs it, and `collie upgrade` reinstalls the whole set.
See [Authoring](authoring.md#skills) for how a workflow refers to one, and
[the skills](#the-skills) for where they come from.
