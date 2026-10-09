# Using Collie

This is the operator's guide: how to install Collie, start a run from inside herdr, read
the Control Plane, answer what a run asks you, and pick up where you left off. For the
vocabulary — Run, operation, host, Choice, Hand-off — see [`CONTEXT.md`](../CONTEXT.md).

## Install

One command, safe to re-run:

```sh
git clone https://github.com/cego/collie.git ~/.collie && ~/.collie/setup.sh
```

`setup.sh` does its own work — clone the checkout or pull it, add the four keybindings
below to `~/.config/herdr/config.toml` if they are missing, configure Claude Code's status
line unless you have one of your own, reload a running herdr — and calls `prepare.sh` for
everything else. That is the one routine that prepares a
machine, and `collie upgrade` and herdr's plugin build hook end in it too, so a prerequisite
is added in one place:

| Step             | What it does                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `plugin-link`    | `herdr plugin link` from this checkout, if it is not already linked from it and herdr is new enough |
| `runner`         | `install.sh`: the runner in `bin/collie`, and a `collie` shim on your PATH                          |
| `operator-skill` | Links the Collie operator skill into `~/.claude/skills/collie` and `~/.agents/skills/collie`        |
| `skills`         | Installs and updates the skills the workflows require (below)                                       |

Every step skips what is already in place, so re-running is a reflex rather than a
decision. `install.sh` writes the shim without changing PATH itself. Keybindings are the
one thing `prepare.sh` never touches: writing to your herdr config is not something a
plugin rebuild may do as a side effect, so `setup.sh` alone adds them.

`setup.sh` ends by running [`collie doctor`](cli.md#checking-an-installation) and exits with
its status, so an install's last word is either that everything is ready or what is missing
with the fix for each.

**An older herdr.** With a herdr older than the plugin manifest's `min_herdr_version`,
`plugin-link` is skipped and says so, everything else still runs, and doctor says what
upgrading herdr will do to the programs running in its panes, and when to do it
([ADR-0048](adr/0048-collie-is-released-for-macos-on-apple-silicon.md), D4). From a herdr
before 0.9.0 the running server must stop once, which ends every program in its panes, so do
it when nothing is running there; `herdr update --handoff` is herdr's experimental way to
carry them across. From 0.9.0 on, `herdr update` leaves the running server and its panes
alone, and restarting the server when nothing is running picks up the rest. Collie never
upgrades herdr or stops its server itself: stopping it ends your work, so when is yours to
choose. Desktop says the same when its herdr has no `herdr machine`, and points at
`collie doctor`.

**On a Mac.** The same command installs the TUI plugin on macOS. Its `darwin-arm64` runner
is the file a release ran on a Mac before signing it, signed ad hoc there if macOS would not
start Bun's build as it was. The logins `collie onboard` and Desktop run use macOS's own BSD
`script`, and nothing needs Homebrew's OpenSSL or GNU tools.

Collie's releases are public, so the install needs no token. A project that is not public — a
fork, or a mirror — answers an unauthenticated download with a sign-in page rather than a binary — with HTTP 200, which is why the install
checks that what arrived is a program rather than trusting the status code. A downloaded
runner is installed only once its signature from Collie's release key checks out. Any
`openssl` will do, macOS's own LibreSSL and OpenSSL 1.1 among them.

For one of those, the install finds a token in this order:

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

### Onboarding a Machine

`collie onboard` installs everything instead, herdr and Claude Code included, from a runner
alone: it clones Collie at the runner's own release (or `--to`) over HTTPS, prepares it the
way `setup.sh` does, puts `~/.local/bin` on PATH in your shell profile. It never runs sudo: a missing `git`, `curl` or `openssl` stops it with the command to run.
It then sets up what a Machine needs to work unattended: Claude Code logged in, glab logged in with a GitLab
token, a key of the Machine's own for pushing unless it can already push, Helle's
credentials and the Linear MCP — the last two unless `--skip` names them. Secrets come on
stdin (`collie onboard --secrets-stdin < secrets.env`), never as arguments. It ends in
`collie doctor`, and onboarded means doctor is ready. Re-running it
repairs only what is missing, and a development checkout gets the checks and the logins
alone. It adds no keybindings; the steps and their `--json` stream are in
[the CLI reference](cli.md#onboarding-a-machine).

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

The CLI runs on the runner's own Bun (`BUN_BE_BUN=1 bin/collie x skills@…`), so no Node is
needed. The step needs the network, which is no reason to leave you without a runner: if it
cannot reach a source it says so in one line, the rest of the install completes, and
`collie upgrade` picks it up next time.

### Optional integrations

Two things a run can reach for that no install can set up for you, because both are a
login of yours. Neither is needed by the bundled `implement` and `review`, so `collie doctor`
reports them without failing, and a run that needs one is refused up front with the fix
rather than failing hours in.

| Integration | Who needs it                                                          | How to set it up                                                                                                                    |
| ----------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Helle       | `renovate`, or any forked workflow with `waits: helle`                | `HELLE_API_TOKEN=<token>` in `~/.config/helle/env`, the file the Helle MCP wrapper sources; Helle is always `https://helle.cego.dk` |
| Linear MCP  | `plan`'s "Offload to Linear"; `implement` given a Linear issue or URL | `claude mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp`, then log in when Claude Code asks          |

Doctor tells the two failure modes apart. Not set up at all is a note under a `✓`, with
the command above. Set up and not working is a `!`: a credentials file without a token, a token Helle answers 401 to, a host that does not answer, a `.claude.json` that is
not valid JSON. Each names the file to look in. `collie run start` asks the same two
questions for the workflow it is about to run and refuses with that detail when the answer
is no — a Run that would only find out at its merge step is not started.

### Working with bodil

Collie has no bodil option. A `bodil` workflow wraps `implement`: it runs `bodil remote up`,
has implement work in bodil's own worktree on bodil's branch, and runs `bodil remote down`
once implement has settled. The module is in
[`docs/sdk.md`](sdk.md#a-checkout-another-tool-makes). Save it as
`~/.collie/user/workflows/bodil.workflow.ts` until bodil's own install script links it, then:

```sh
collie run start bodil --input plan=… --input brands=happytiger
```

`--input name=<name>` names the instance; without it the Run's task name does. A Run
stopped part-way leaves the instance up, for `bodil remote down <name>`.

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
3. One question: **What do you want?** Your words fill the workflow's one launch Input
   where they are a value of its kind — any words for `plan`'s goal or `implement`'s work
   source (a plan directory, a Linear issue, or the words as text), a merge request URL,
   an iid or a branch for `review`'s target, a URL or an absolute path for `renovate`'s
   repository. Every other Input is inferred from the branch, open MR and earlier runs, or
   left empty; nothing else is asked. A start still missing a required Input is refused
   with the reason. A workflow that takes no Input starts from the menu alone.
4. Where anything was inferred, one row says where the run starts and each Input as
   `name = value (inferred from …)` or `(given)`: Enter starts it, Esc starts nothing. A
   start with nothing inferred starts at once. The run records which Inputs were inferred,
   and `collie run show` lists each with where it came from.
5. The workspace's **Control Plane** tab opens, and it is always the workspace's first
   tab, so `prefix+1` lands on it.
6. The run's own tabs hold agents and nothing else: one tab per agent it starts, labelled
   with the agent's role — `implementer`, `reviewer` — in the order they started, each
   `cd`-ed into the checkout the run works in. An operation that reuses an agent opens
   nothing. The label carries no state: the run's card on the board says what it is doing,
   and herdr's own agent-status column says what each agent is.
7. `plan`, `architecture` and `review` end in a question — **What next?** — answered on the
   run's card, with `collie run answer`, or in chat. Launching asks nothing about it: a
   question is asked when the run reaches it, so you decide with the work in front of you.
   `prefix+u` asks the host to pick a run that is still going back up.

The same operations are available without opening UI, which is how an agent drives Collie:
see [CLI](cli.md).

### Tasks: one workspace per piece of work

Starting a workflow starts a **task**, and a task gets a herdr workspace of its own. It is
never focused: starting work does not take you away from what you are looking at. Everything the task takes stays there: the
plan's tabs, the implementation it chains into, the review of that, and any follow-up.
A start about a branch a task already works — one placed on it, or reviewing it — joins
that task wherever you start it from. Any other fresh start, including one from
inside a task workspace, makes another one; unrelated tasks never accumulate beside each
other.

To put more work into a task you already have, continue it rather than starting fresh:
the `cego.collie.continue` action, or `C` on the Control Plane. Inside the task's own
workspace that task is meant and nothing is asked. From anywhere else you pick from a list
of tasks, headed by **This workspace**: the work stays in the workspace you are in, which
becomes its task — `collie run start --here` from a shell. A mutating workflow still gets
its own worktree; its agents simply open beside you rather than in a workspace of its own. Nothing continues a task by accident — not a workflow with the same name, not a
workspace whose label looks similar, and renaming a task workspace by hand changes nothing
about what belongs to it.

Finished tasks keep their workspace, with their conversations and reviews in it, until you
close it yourself. Nothing is moved, renamed or cleaned up: workspaces and runs from
before this existed stay exactly where they are and belong to no task.

A task workspace groups work. It gives no file or branch isolation — that is what the
worktree below is for, and it is unchanged.

Stopping a run closes its agents' panes, which is what stops them, and nothing else in the
workspace. The workspace's own shell tab is never given to an agent, so closing an agent's
pane never leaves it empty, and `run resume` starts the work again there. If herdr closes it anyway, the next agent the task starts reopens it on
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
in it while its work has not landed, its merge request is merged or closed on GitHub or
GitLab (or a Disposition says what became of it, or its remote branch is gone), and its
Task's workspace has closed. A squash merge counts: the head that merged is on the remote. A
`renovate` checkout has no branch to ask either question about, so a clean one nothing is
working in is settled, and there is no branch to delete with it. Pruning is part of the
host's [cleanup](#cleanup) sweep, every ten minutes, whether or not a pane is open. The board says both what went and what is being held on to, with
the reason:

```
Worktrees
  ♻ removed add-a-picker · merged in !14
  kept fix-the-parser · 2 commit(s) on no remote
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
cards on this one, and the search is what narrows to it. The host builds the board and the
Home follows what it serves, as the text view, chat and `collie --json board` do
([ADR-0038](adr/0038-the-host-builds-and-serves-the-board.md)), so none of them can show a
card the others do not. Your work stays where it is — a
Run still runs in the workspace it was started from, and so do its worktrees, its agents
and its hand-offs.

The Home is **owned by metadata, never by a label**: the workspace and the board's pane
carry a token naming this Herd, and Collie's record of which workspace that is counts only
while the token — or the recorded pane, still with the terminal it was recorded with —
proves it. While it is proven, the host restates the token every four hours, so a board left
open for days keeps it. A herdr restart drops every token and gives each pane a new
terminal, so a Home whose workspace is still there, whose record says it was finished, and
which no other workspace claims is healed: re-tokened, with its panes taken back or
reopened, and `collie home show` says when and why. Two workspaces claiming it, or a claim
that is not this Herd's, is a question Collie refuses to answer for you: rather than draw a
board it cannot say is this Herd's, the shortcut prints why, names the candidates and gives
you `collie home reconcile`. Nothing is created because a token expired, and nothing is
adopted because it looks right.

The Home is **one tab with two panes**: the board on the left at four sevenths of the
width, and [native chat](#talking-to-collie-about-a-herd) on the right at three. Both
are ordinary panes — herdr's own keys move between them and resize them, and reopening the
Home reopens only a pane that has actually gone, so a divider you dragged stays where you
put it.

It is a board, not an engine: it draws the Runs the host holds, the register of live agents
and the steering journals, so closing it loses nothing — the next run opens it again. The run
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
collie home show                 what Collie thinks the Home is, what proves it, and why it last healed
collie home reconcile --adopt w7 that workspace is this Herd's Home
collie home reconcile --forget   forget the record; the next launch decides again
collie home cleanup --confirm    close the legacy panes that are alone in their tab
```

The Home has no checkout of its own, and a start from it never asks for one
([ADR-0033](adr/0033-a-run-started-from-the-home-is-placed-not-asked.md)). A workflow
whose launch Input is a goal — `plan`, `architecture` — starts at the
[Projects root](../CONTEXT.md), and its agent is told the root is not a repository and
that each ticket's `Repo:` is a path relative to it.

Any other workflow is **placed from your words** in one of the checkouts under the
Projects root. A merge request or repository URL is matched to the checkout whose `origin`
or `upstream` remote is that project, with no model asked. Otherwise one small model call
(`haiku`, low effort, recorded in the Herd's `budget.jsonl` like task naming) is shown the
checkouts and your words and names one of them, several, or none. One checkout is shown as
**Starting in** that path — Enter starts there, Esc cancels — and the run records its
checkout as inferred. Several, none, or a model that could not answer offers **Plan it
instead**: a `plan` at the Projects root with your words as its goal. Where the run lands,
its Input follows: a repository Input is that checkout, a review target is inferred there
(or refused with the reason), and a work source keeps your words. A `renovate` URL that
matches a checkout runs there; one that matches none is cloned, as before.

It is an application ([ADR-0005](adr/0005-collie-tab-is-an-application.md)), and it is a
**board of Tasks, not a table of Runs**
([ADR-0013](adr/0013-the-board-is-cards-of-tasks.md)): one card per
[Task](../CONTEXT.md), whatever Runs that Task took. A header sentence, then four sections
that answer four questions in order — what needs you, what is waiting on you, what is
working, what finished. A decision beats liveness, liveness beats history, and history is
split by whether the work **landed**. The order is the board model's own, and the text
board and chat's `collie_herd` list the sections the same way.

**Needs you** is one card per Task that has stopped for you: an open decision you answer
on the card, or an agent waiting for you in its own pane — a harness dialog herdr will not
answer, or a run that parked because its agent's pane would not take a prompt. The second kind has nothing to
answer under the card and says where to go instead (`Waiting for you in build-r7's pane.`);
Enter on the card gets you there. Either way the work has stopped, which is what the
section is for. **Working** is one card per Task something is
actually doing — a Run the host holds that has not settled, or an agent herdr still has: its name,
its project, one plain sentence about what is happening, one amber line when it has
drifted, the step glyphs, where it has got to, how many agents are on it and how long it
has been going. The sentence names the step the Run last launched an agent for, with its
round (`Fixing the review findings, round 1.`, `Building ticket 02.`). Silence past
`board_quiet_ms` reads `…but silent for 14 minutes` and moves nothing; a Run whose agent
herdr reports working, or whose check Collie is running, is never silent. While Collie runs
one of the Run's checks itself, the sentence is about that check rather than the last step:
which check, which pass and why, how long it has run against the median of its last five
runs in this repository, and how many other checks this host is running —
`Running test where the branch left master, to see whether it failed before this Run, 12
min of a usual 20. 3 other checks are running.` With nothing to compare against it says
only how long; over the usual it says `longer than the usual 20`. The drawer, `collie_run`,
`collie_herd` and `collie run checks` say the same
([ADR-0042](adr/0042-a-check-collie-runs-is-seen-while-it-runs.md)). The check's output is
written to a log as it arrives: the drawer's Summary shows its last lines under the
sentence, and **Open check output** in the card's menu opens a pane in the Task's workspace
following it live (`collie run checks <run> --follow`) until the check ends. A finished Run is
**Reopened** when one of its agents took something you told it after the Run ended
([ADR-0041](adr/0041-a-finished-run-still-takes-steering.md)): while herdr says that agent
is working, its card is in Working with `Working on what you told builder: “merge and tag
it”.`; while it is blocked, the card is in Needs you naming its pane; once it is idle, the
card stands on its own facts again — Ready to release, Waiting on you or Finished — and
chat is told once that it finished what it was told. Nothing records it: the delivery
ledger says what was sent and when, herdr says what the agent is doing, the step glyphs
still show the Workflow's steps as they ended, and `run show` still says `succeeded`. **Waiting on you** is work that ended without landing, and that nobody has
asked you about: an implement that succeeded and whose merge request is open, a plan that
is ready to implement, a Run that failed, was stopped or was abandoned with a branch or a
merge request behind it and has neither been resumed nor disposed of. An implement whose
merge request is open says what checked it, from Collie's own checks counted only at the
revision its branch is at now in its checkout (where that cannot be read, the newest
revision Collie checked): `cego/collie!65 is open, but lint failed at 1a2b3c4. Next: fix
lint, or tell builder to.`, or `cego/collie!65 is open; nothing has checked it.` Where
every check passed it is **Ready to release**, leads the section, and says so: `Ready to
release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: merge it, or tell
builder to.` The agent is named only while it is alive. A GitHub pull request reads as
`owner/repo#30`, a GitLab merge request as `group/project!42`. A Run that ended with
nothing to file — no branch, no merge request, no plan, no question — is finished, not
waiting: fifty such cards are not fifty obligations. Each card's first button is the one
action that ends its wait — Open MR, Resume, Mark superseded, or on a plan that is ready
the first offer its workflow declares, under the title it gave it (the shipped plan's is
**Implement now**, refused with how to build it for a plan that spans repositories; a plan
that declares none gets no button) — with Mark merged and Mark
abandoned beside it in the menu. After what is ready to release, the newest ending is at the top; anything
older than a week folds into one counted line, `▸ 9 older than a week`, and the header
counts the week's endings while the fold counts the rest. **Finished** is work that landed
— a disposition was recorded, the Run succeeded at a workflow that produces nothing to
land, such as a review, or it ended with nothing to file — as one line, `3 finished today,
1 failed`, until you click it open; anything older than a day is behind `older…`, which
reads it from this checkout's history rather than carding every Run Collie has ever kept.

Collie learns a merge by itself, whether or not a pane is open: the host asks GitLab
(`glab`) or GitHub (`gh`) about each merge request in Waiting on you every 5 minutes; one
that merged gets its `merged` disposition recorded as that forge's word and its card moves
to Finished. One that was closed without merging only changes its card's sentence: closing
can mean superseded as easily as abandoned, and only you know which. The same answer
carries the forge's own checks — GitLab's head pipeline, GitHub's check rollup — and the
revision they ran at, which is the one Collie's own checks are counted at too: a failing
one names itself (`cego/collie#30 is open, but lint failed at 1a2b3c4.`), a pending one
reads `cego/collie#30 is open; its pipeline is still running.`, and Ready to release needs
every check the card knows of to have passed. No `gh`, or one nobody logged in to, leaves
the card `nothing has checked it` and says nothing about why.

The header sentence counts the whole Herd, not what the search left: `One task is
waiting on you. 1 ready to release, 2 waiting on you. 4 working, 1 gone quiet.` — the
middle counts being this week's endings, the older ones sitting behind the fold — amber while anything needs
you and muted otherwise. After it, each Subscription's busiest window in a few characters —
`claude 31% · chatgpt 2%`, naming the model where a model's own window is the busiest
(`claude Opus out`) — amber at 90% or more and `out` once one is Exhausted; it is
the first thing to give way on a narrow pane ([Usage](#usage)). Beside it, a search field (`/`) matching a task's name, its project, its branch
and what its agents are called and are doing, and **New run**. At the left, the brand
signature — the mascot and the lettering, drawn as a picture over the Kitty graphics protocol —
appears when every terminal attached to herdr paints such pictures (Ghostty, kitty,
WezTerm; not Alacritty); otherwise the plain `collie` wordmark stands there instead. herdr answers the protocol's handshake on its own, so the board reads the
attached clients' `TERM` instead, and draws no mark rather than a blank when unsure.

```
collie  One task is waiting on you. 1 ready to release. 2 working, 1 gone quiet.   ⌕ find a task   + New run

NEEDS YOU
┌─────────────────────────────────────────┐
│◆ RUM sourcemap upload  frontend-core  9m│
│Waiting on your answer about the cap.    │
└─────────────────────────────────────────┘
WAITING ON YOU · 1
┌─────────────────────────────────────────┐
│✓ Control plane redesign    collie    2h │
│Ready to release: mk/collie!65 is open   │
│and its checks passed at 1a2b3c4. Next:  │
│merge it, or tell builder to.            │
│✓✓✓✓✓  done                              │
│ Open MR   ⋯                             │
└─────────────────────────────────────────┘
WORKING · 2
┌─────────────────────────────────────────┐┌────────────────────────────────────┐
│● Strapi prod seeder        content   58m││● Docs run          collie       5h │
│Fixing the review findings, round 2 of 5.││Building, but silent for 3 hours.   │
│↯ editing src/ui/App.tsx, outside the    ││                                    │
│✓●○  review  2 agents                    ││●○○  build  1 agent                 │
└─────────────────────────────────────────┘└────────────────────────────────────┘
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

A run holding at its [evidence gate](cli.md#outcomes), parked because nothing is approved
for Collie to run, is a decision card too, and says which checks its checkout's
`.collie/verify.json` offers. **Approve** grants the list as it stands and takes the run up
again, and **Edit the list** opens the record with the names to tick off — `Approve the
list` grants what is left. There is no Skip: with nothing approved, no check could prove
the run. The answer goes on the record under whoever gave it.

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
where it was, so reading one Task never costs you the overview. Everything in it comes from
the host and follows the Run while the drawer is open, the log tail included; the merge
request is what the host's merge watch last read, and `R` asks it again.

**Point at a card** and, where its age was, `go to tab` and `⋯` appear; the card does not
move or grow. `⋯` opens that Task's menu, and so does a right-click anywhere on the card —
use `⋯` in a terminal that keeps the right button for its own menu. Clicking anywhere else
closes it, as does Esc, and the key beside each item does it from the keyboard:

|         |                    |                                                          |
| ------- | ------------------ | -------------------------------------------------------- |
| `enter` | Open record        | always                                                   |
| `g`     | Go to its tab      | always                                                   |
| `s`     | Steer…             | while something is still driving it                      |
| `a`     | Attach files…      | while something is still driving it                      |
| `w`     | Open merge request | when there is one                                        |
| `i`     | its first offer    | a plan that is ready, by its title                       |
| `o`     | What it offers…    | always: the workflow's own offers                        |
| `u`     | Resume run         | failed or stopped                                        |
| `x`     | Follow-up run      | finished                                                 |
| `h`     | Hold run           | working, quiet or waiting on you; Release hold once held |
| `k`     | Stop run           | working, quiet or waiting on you                         |

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

**Attach files…** asks which files to give the Run: paths separated by spaces, quoted as a
shell quotes them where a name has a space, and relative to the board's own directory.
They go to the Run's newest live agent as a steer with no words of its own, the steer
`collie run steer --attach` makes: the host copies each into the Run's `attachments/`, the
agent is told each path, and every later step's prompt lists them. A Run with no live
agent left is told so, with the follow-up that would carry the files on instead.

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
`config.json`, and whether the harness is trusted here. The defaults are every setting
`src/settings.ts` lists — `proactive`, `models.<harness>` and `notifications.<kind>` among
them — and once a Desktop shares them with its Flock each says "shared with the Flock by"
that Desktop's computer: an edit here then reaches every Machine. Each fills the pane, `close` or
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
  constraint marked `¬`), the files the Run was given, each with its size and its path
  in the Run's directory where its agents read it, the steps with a duration each, the live agents — each saying
  what it is doing right now, from the terminal title its harness publishes, so progress is
  visible without opening the pane — every agent the Run started under **ran on**, with the
  harness, model and effort each ran on (`build  claude/opus medium`) — the branch, and the
  merge request behind it: state,
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
- **Log** — the end of the run's `log.txt`: what the host saw of its work — drift found
  and cleared, corrections sent, verifications it ran, and how aligned the run finished.
  A run with nothing to say there says so, because its agents' panes are its record. It is
  read only while this tab is showing it, because a log can be any size.

The review and the plan's spec are capped and paged: `… truncated` says so, and `m` reads
another cap of it. They are markdown, drawn through [Comark](https://comark.dev)'s
terminal renderer: headings, emphasis, lists, tables and fenced code are styled, and
Comark's security plugin drops scripts and embedded content first, because what an agent
writes is untrusted. Tables and rules are drawn to the drawer's width. The log is shown as plain text.

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

A card's header names what it is about: `slice · build · abc1234 · try-it` — the kind,
the piece of work, the revision it was written against, and how
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

## Collie Desktop

**Desktop** is a desktop app, released for Linux (x64) and for Macs with Apple silicon, that shows the **Flock** — every Herd on every
Machine it reaches — on one board. It lives in `desktop/` and is one more front door over
the same board: it reads each host's stream and builds nothing of its own. The sections and
the header sentence are counted across the Flock. Once there is more than one Machine, each
card names its Machine, and its Herd too when that Machine runs more than one herdr
session.

Desktop is released with Collie, under the same tag and version. Install it for your user,
on Linux with a desktop entry and on a Mac into `~/Applications`:

```sh
curl -fsSL https://github.com/cego/collie/releases/latest/download/install-desktop.sh | sh
```

The script downloads the latest release's installer and uses it only once the download
verifies against Collie's release key. Any `openssl` will do. On Linux it runs the installer.
On a Mac it attaches the DMG without opening a Finder window, copies **collie-desktop**
into `~/Applications`, replacing an older copy, and detaches it again; open it from
Spotlight or the Dock. An Intel Mac is refused: Desktop is released for Apple silicon only,
and the TUI plugin works there.

Until a release is notarized by Apple, a DMG downloaded in a browser is quarantined and
Gatekeeper refuses to open the app in it. The script avoids that: `curl` sets no quarantine,
and the app it copies is signed. If you did download the DMG in a browser, install with the
script instead.

**On a Mac, the Mac is Local.** Agents run on it as they do on Linux. A VM is a second
Machine only if you want agents to run there too: add it with `herdr machine add` and
Desktop shows it beside Local. bodil's `--vm` backend is bodil's own business and not a
Collie Machine, so a VM bodil uses needs no `herdr machine add` for that.

On macOS, Desktop opened from Finder or the Dock starts with launchd's short PATH. So at
start it takes your login shell's environment (`$SHELL -ilc`), including its PATH, finding
`herdr`, `collie`, `claude`, `git` and `ssh` as your terminal does. If the shell does not
answer within five seconds, Desktop keeps the environment it was given and logs why. On Linux it
keeps the environment its session gave it.

It shows up as **Collie**, with the Collie mark — the dog on the white tile the TUI board
shows, which reads on a dark taskbar too — in your app launcher, on its window, in the
taskbar and at the top left of the board.

Desktop then keeps itself up to date. It checks the latest release when it starts and every
hour after, and downloads an update in the background. **Settings**, under **About**, shows
Desktop's own version with **Check for updates**, which checks now and says what it found: "Collie 0.34.0
is up to date", "Downloading 0.35.0", the ready notice below, or why the check failed. A
check asked for while one runs joins it rather than downloading twice. It installs nothing until the
tar it would install verifies against the same key, because Electrobun's bundle hash is
not authentication. An update that is unsigned or does not match is thrown away and said
so. One that verifies is announced as "Collie 0.33.0 is ready, restart Desktop", and
**Restart Desktop** installs it. Desktop never restarts itself: an update that is ready when
you quit is installed the next time you start Desktop. It updates itself the same way on a
Mac. On Linux, [`collie upgrade`](cli.md#upgrading)
on this computer also stages the same update for Desktop, verified the same way, so the CLI and
Desktop move together; a running Desktop announces it within a minute. A ready update stays
announced through later checks, even one that fails. A Desktop run from a checkout
(`bun run start`, or any build that is not the stable channel) never updates itself, and
**Settings** says so. The new
Desktop then upgrades your released Machines to its version as they connect.

Desktop keeps only what it uses. When it starts it removes every staged update but the one
it is running, which is the base the next update is patched from, and one staged and not yet
installed; every runner copy but its own version's and the newest; usage lines over 30
days old; and the SSH control directories, with their masters, of a Desktop that is no
longer running. [`collie cleanup`](cli.md#cleaning-up) lists the same files of Desktop's, as
the kind `desktop`, on a computer that has Desktop
([ADR-0045](adr/0045-collie-removes-what-it-made-once-nothing-needs-it.md)).

The Machines are this computer and every machine enabled in `herdr machine list`; Collie
keeps no list of its own. At launch Desktop opens one SSH master per herdr machine, from
its target and your own SSH config, so an SSO check is made once per machine, and keeps it
open until Desktop quits. A Machine reached two ways — two herdr machines on one computer,
or one pointing at this computer — is shown once, through the first in herdr's list (this
computer before any). It is named by that herdr machine's label, or the hostname here, and
two Machines with one name show as `name (ssh target)`.

A Machine Desktop cannot show live says why above the board, by name:

- **Out of reach** — SSH or its bridge failed, or the connection dropped, with what it said.
  Its cards stay on the board, dimmed and marked "as of HH:MM" (when it was last live),
  with every action on them off. Desktop tries again by itself, waiting 1 s after the first
  failure and twice as long after each one after it, up to a minute, and opens a new master
  if the old one has gone.
- **Waiting for SSO login on _name_** — the master is waiting on an SSO login (the sshd
  printed a line naming SSO). Its board appears once the login clears; nothing has to be
  pressed.
- **Collie isn't installed on _name_** — the machine answered, but its login shell has no
  `collie`. **Onboard** onboards it, as below. Until it has a host, it is known by its
  herdr profile id. Once a host there answers, it becomes the Machine that host's
  installation id names, as one more Machine or as the one already shown.

Desktop keeps the Flock on its own build. When a Machine on a release older than Desktop
connects, Desktop runs `collie upgrade --to <its version>` there through the same route
as the bridge. No prompt is shown, and a notice says "vm-mk upgraded 0.26.0 → 0.27.0".
Desktop then opens the Machine again, and the new build replaces the old host, as any
newer `collie` does. Desktop never stops, signals or restarts a host itself. It asks a
Machine at most once each time it connects. One whose upgrade failed says why in a notice,
is shown as it is, and is asked again the next time it connects, so a Machine out of reach
at launch follows Desktop once it is back. One that upgraded but did not move is shown as
it is. A Machine on a development checkout (a non-release branch or tag,
uncommitted changes, or commits its remote lacks) is never upgraded. **Machines** shows its
build as "development build <version>+<sha>", and never counts it behind on its version. Desktop reads any host inside
the protocol window ([ADR-0038](adr/0038-the-host-builds-and-serves-the-board.md) D5): its
own protocol version and the one after it. A host whose board is newer than that, or one a
newer collie serves that Desktop cannot decode, is not shown, and its row says **Update
Desktop to see _name_**.

A host that is not running needs nothing from you, because the bridge starts it. Desktop
saves each Machine's last board on this computer, under
`$XDG_DATA_HOME/dk.cego.collie.desktop/<channel>/machines/` on Linux, or
`~/Library/Application Support/dk.cego.collie.desktop/<channel>/machines/` on macOS. At launch it shows those boards
dimmed, marked "as of", until each Machine's connection is live; a board saved through a
machine herdr no longer lists is not shown.

Every Decision and action the TUI board has is on Desktop's cards, and goes to the Machine
the card is on. A question is answered with its options, or typed into where it has none;
an evidence gate is approved with the checks still ticked; and a proposal is read in a
drawer whose Confirm stays off until all of it has been on screen, then sent with its id
and content hash. Each card's `⋯` menu offers what the TUI menu does, by the same rules —
Steer…, the Run's offers (asked of its host when opened, with a field for each argument),
Resume, Follow-up, Hold or Release, Stop, and Mark merged, abandoned or superseded — and
the card's first action is the TUI card's own. Following a check's output is not on Desktop
yet. Open merge request opens it in your browser.

**Go to pane** asks the card's Machine to focus the Run's newest live agent, or its
workspace where it has none, on that Machine's own herdr, and opens the card's record on
its **Terminal** tab, which shows that agent's pane. It is herdr's own controller for the
pane, run over the connection Desktop already holds to the Machine: one more channel on
its SSH master, so going to a pane never asks for another login or SSO approval, or a
local process for this computer. Nothing beyond Desktop is needed on this computer. Type
into it as into herdr — Esc and Ctrl+C go to the agent, not to the record, and Ctrl+C
copies instead while text is selected; a multi-line paste arrives as one paste; the wheel
scrolls the pane's own history; and the pane follows the record's size. A link in it opens
in your browser. A pane cannot write your clipboard.
Leaving the tab or closing the record gives the pane back, so a herdr window showing it
returns to its own size. A terminal that ends says why — the pane closed, another client
took it over, the Machine's connection dropped, or herdr refused — and **Reattach** finds
the Run's newest live agent again. The tab stays while its Machine is away, and Reattach
says that Machine is not connected until it is back. The card and the tab say where the pane is, as
"vm-mk › workspace 3 › tab 2".

Where the Task has more than one live agent — a planner, an implementer and its reviewers,
across a plan Run and its `.implement` Run — the tab lists every agent the card counts
beside Open in herdr, each as its role (numbered where two share one, as "reviewer 1") with
herdr's status, and its herdr name and terminal title on hover. The one marked is the pane
the Machine says it focused. Picking another gives the shown pane back and opens the chosen
one, and Reattach then reopens the chosen agent rather than the newest. An agent that ends
while shown stays listed as **ended** until you pick another. Leaving the tab forgets the
choice, so coming back, like Go to pane, shows the newest live agent again.

Where there is no pane to show — a Run with no live agent, or a Machine on a Collie whose
focus does not name one — Go to pane does what it did before, and **Open in herdr** on the
tab does it on purpose, for the full herdr UI: a new herdr client in this computer's
terminal, attached to that Machine's session: `herdr --remote <target> --session
<session>`, or `herdr --session <session>` for this computer, with no `--session` for
herdr's default session. The terminal is `x-terminal-emulator` where it exists, else the
first of `gnome-terminal`, `konsole`, `kitty`, `alacritty` and `xterm` on PATH; on macOS it
is Terminal.app. Where no terminal was found, or it failed as it started, the card shows
the command to copy. A Run with no live agent is looked for only in its Task's own Herd,
since workspace ids are only unique within one. **New run** asks a Machine what a project
can start, then starts it with what you typed for its inputs. What came of each, or the
host's own words for why not, is said in a toast, and **Try again** on a failure sends the
same request again, so a host that took it before the answer was lost does it once; the card then changes from the host's
stream like any other change. Every one is recorded on that Machine as `desktop`, with this
computer's name.

**Machines** is a page that lists every Machine Desktop reaches — this computer first, then
herdr's — with how it stands, and is where Machines join the Flock. Each joins the same way:

- **Add Machine** opens a dialog that takes an SSH target, a label and a herdr session
  (`default` unless you say), all three needed; adding closes it and runs `herdr machine
  add` in a terminal Desktop drives. herdr's own questions — whether to install herdr there, whether to replace a running server — are dialogs, and
  closing one answers herdr's default, which for replacing a server is No. herdr saves the
  machine, so its list stays the only one, and Desktop then onboards it.
- **Onboard** on a Machine herdr already has, or on this computer, onboards it there and
  then. It is the same button on a Machine whose Collie isn't installed.

The page opens with one line saying whether the whole Flock is **In sync** with Desktop
("Every Machine is in sync with Desktop 0.35.0"), or naming each Machine that isn't and what
it lags on. Each Machine's row shows the Collie it runs — "Collie 0.35.0", "development build
0.35.0+abc1234", or "Build not known yet" for one never seen live — and one state: **In
sync**, **Behind**, **Connecting**, or why it isn't live (**Out of reach**, **Waiting for
SSO**, **Collie isn't installed**, **Update Desktop**) with what it said, and **Check for
updates** where it needs a newer Desktop. A live Machine is behind on its
version when it runs a release older than Desktop's, which the row says with both versions;
never on a development checkout, and never while Desktop itself isn't a release. It is
behind on settings when its last settings sync failed, with the host's reason; behind on
credentials for each credential Desktop holds that it lacks, with why the last give failed
where one did, though never on one its onboarding skipped, which Desktop gives only when the
token is saved or renewed; and behind on onboarding when `collie doctor` doesn't find it onboarded, and
the row lists the missing steps with their fixes. A part not known yet, such as a first sync
not finished or doctor not having answered, is not counted, and a credential Desktop holds
none of is no Machine's to lack: the summary says "Desktop has no GitLab token to give"
instead. **Sync now** on a Machine behind on its version, settings or credentials does what
connecting would: behind on its version, it reopens the Machine's connection, which asks the
upgrade again and then syncs and gives on the new one; otherwise it syncs its settings and
gives it what it lacks. A toast says what it did, red where a part of it failed. The Flock
chat reads the same standing and does the same Sync now through `collie_in_sync`. The header's **Machines** button shows how many Machines aren't in sync, those
still connecting left out.

Beside **Machines**, the header names each **Subscription** and account in use across the
Flock with its busiest window, as in `Claude 72% · ChatGPT 2%`, naming the model where it is
a model's own (`Claude Opus out`): amber at 90% or above, red
and "out" once it is **Exhausted**. Hovering an entry gives its account, when that window
resets and which Machine read it how long ago, and clicking it opens Machines. Machines
logged in to one account are one entry, matched by the account's id rather than its email,
and two accounts are two, each named; the provider counts usage per account, so the entry
shows the newest of its Machines' readings. On the Machines page each Machine has a
**Usage** block: per Subscription its plan and account, each window as a meter with its
percent and when it resets, as a clock time and "in 2h 10m", and how fresh the numbers are
and where they came from ("as of 3 minutes ago · Claude's usage endpoint"), or the
reading's problem in its own words. A Machine running a Collie too old to read usage says
"can't say; upgrade this Machine". Desktop asks every live Machine when it opens, again
each minute while its window is shown, and whenever Machines opens; each host answers from
its own reading, which is at most five minutes old unless its source is refusing
([Usage](#usage)).

Onboarding downloads the runner of Desktop's own version for that Machine from the GitHub
release, with its `.sig`, and verifies it against Collie's release key before it goes
anywhere; one that is unsigned or does not match is refused and said, and nothing reaches
the Machine. The verified runner is kept on this computer, checked again each time it is
used, and put on the Machine under `~/.cache/collie/runners/` only once what arrived has
the same SHA-256. Desktop then runs `collie --json onboard --to <its version>` there and
shows each step as it streams: a step that needs root shows the exact command to run and
**Retry**, and one that needs you shows what to open. A Machine onboarding left short lists
its missing steps on its row in Machines, each with its command or link and **Retry**;
onboarding again repairs only what is missing. Once onboarding ends, Desktop tries the
Machine's board again at once rather than after its backoff. Desktop keeps each Machine's
latest onboarding on this computer, beside its saved board. Whether a Machine is onboarded
is `collie doctor`'s to say: once a Machine is live, and after each onboarding of it,
Desktop runs `collie --json doctor` there, and its row lists each check that failed, with
its fix and **Retry**, even on a Machine Desktop never onboarded. Helle and the Linear MCP
count too, though doctor passes them as optional: the row lists either one doctor finds
absent or not working, and a Linear login onboarding left unfinished. **Skip on this
Machine** on either step onboards it again with `--skip`, and every later onboarding of
that Machine skips it too.

What only you can give is asked once, in **Settings** under **GitLab and credentials**, and
never pasted on a command line. Desktop keeps the Flock's credentials in a file of Desktop's own,
`$XDG_CONFIG_HOME/collie-desktop/credentials` (`~/.config/collie-desktop/credentials`
unless that is set), readable by you alone and replaced whole on every save — the way glab,
gh and Helle already keep the same tokens on every Machine, so nothing has to be installed
for it. A Desktop that kept them in the Secret Service through `secret-tool` before has them
copied into that file the first time, where `secret-tool` is there. What it keeps is one
GitLab token, made on GitLab's own page — **Make one on GitLab** opens it with the `api` and
`write_repository` scopes filled in — and Helle's token; Helle's URL is always
`https://helle.cego.dk` and is never asked for. Desktop takes a token only once GitLab
accepts it with those scopes, and gives it at once to glab on every Machine it reaches
(`glab auth login --hostname <host> --stdin`); Helle's goes to each Machine's
credentials file, owner-only, the same way. Every onboarding gets what is kept on its stdin (`--secrets-stdin`), so a second
Machine asks for neither. A Machine that lacks a credential Desktop holds is given it each
time it connects, the way its settings are synced, so one that was out of reach when a token
was renewed gets the new one when it is back. Desktop knows which Machine has which by a
fingerprint of what it gave each — the first 16 hex digits of its SHA-256, never the secret
— kept in `given.json` beside `flock-settings.json`; a give, a save or renewal that reached
the Machine, and an onboarding that ended ready all record one, and removing a Machine drops
its record. A Machine given the current one is not touched again. A step that needs one you have not given yet takes it
there and onboards again. Desktop asks GitLab when the token expires, at launch and when it
is saved, and warns above the board from 14 days before, where **Renew** opens Settings;
**Renew** there with a new one replaces it on every Machine.

That GitLab is one host for the whole Flock, `gitlab.cego.dk` unless you name another in
**Settings** (**Use this GitLab**), which is the Flock's `gitlab_host` setting below. It is the token
page Desktop opens, the GitLab a token is checked against and logged in to, and the
`--gitlab-host` every Machine is onboarded and doctored with, so each Machine's readiness
is that host's. A change applies at once, without a restart, and every Machine is doctored
again. It also forgets the GitLab token Desktop kept, since a token is made for one GitLab:
make a new one on the new host's page and save it. The GitLab host is given to every
Machine but never taken from one: an edit of `gitlab_host` in a Machine's TUI stays that
Machine's.

**Settings** is a page in the board's column, at a readable line length, and re-reads the
Flock's settings each time it opens. It is grouped under headings, in order: **Agents**, **Runs**, **Board**, **Chat**,
**Notifications**, **GitLab and credentials** and **About**. It holds every setting the TUI's
Settings offers — each default a Run reads, `proactive`, the extra `models.<harness>` and each
`notifications.<kind>` — and the Flock chat's own settings. Each setting has a plain
name with its config key in small print, a sentence or two on what it changes (what 0 or
unset means where that matters, and that `scope`, `density` and `questions` change the TUI's
board, not Desktop's), a control that fits it (a choice, a number, a switch, or text), its
default, and the same refusals as the TUI. Durations — `quiet_ms`, `handoff_timeout_ms` and
`board_quiet_ms` — are shown and typed in minutes, decimals where a value is not a whole
number of them, and still stored in milliseconds, so `config.json` and `collie settings` are
unchanged. **Reset to default**, shown while a setting is set, unsets it. Each says whether
**Every Machine** shares it or it is for **This computer only**. Under **Chat**, the Flock
chat's **Flock chat harness**, **Flock chat model**, **Machine rule** and **Flock chat speaks
first** are this computer's, like the bell in the chat's header. The harness offers
`claude` and `pi`; the model is a one-line field, with **Unset: opus** for Claude and
**Unset: pi's own default** for Pi. It is checked as a Run's model is, including
**More Claude Code models** and Pi's `provider/model` form, and a refusal saves nothing.
The groups, names, descriptions and
units live with each key in the one list of settings (`src/settings.ts`) that the TUI's
Settings reads too, so a new setting shows up in both, except those for this computer only,
whose are in `DESKTOP_SETTINGS` (`desktop/src/shared/flock-settings.ts`); the TUI does not show the names,
descriptions or minutes yet. The ones every Machine shares are the Flock's: Desktop keeps them in
`flock-settings.json` beside its chat, and gives them to every Machine through that
Machine's host, never by editing a file over SSH. A Machine is synced each time it
connects and after every edit in Settings, so one out of reach gets an edit when it is
back, the way upgrades reach it. An edit on one Machine's own TUI Settings counts the
same: Desktop takes it the next time it sees that Machine, or when Settings is opened, and
spreads it. Each key is decided by whichever edit was made last, wherever it was made
([ADR-0043](adr/0043-a-shared-setting-is-its-latest-edit.md)); on the first sync a key set
on one Machine only is taken from it, and a key set differently on several takes the latest,
with Settings saying beside it which Machine that came from. A value a Machine holds that
its setting refuses, written into its file by hand, is not taken. What stays each Machine's own
is everything else in its `config.json`: remembered answers such as `linear.team` and
`gitlab.assignee`, `chat_harness`, and `projects.root`, which is a path on that Machine.

**Zoom**, under **Board** and for **This computer only**, is how large Desktop draws: 80%,
90%, 100%, 110%, 125% or 150%, where 100% is the size of the other apps on the same monitor.
A change applies at once to every Desktop window, the popped-out Flock chat included.
Desktop is drawn through XWayland, which renders it at one whole-number scale on every
monitor, so on Hyprland Desktop reads the scale of the monitor holding each window from
`hyprctl -j` and corrects for it with Chromium's own page zoom, again whenever a window
moves, resizes or takes focus: moving one to another monitor resizes it, and text stays sharp
([ADR-0047](adr/0047-desktop-draws-at-its-monitors-own-scale.md)). **About** says how the
board's window is drawn — "Drawn at 1.5× on DP-1 (3840×2160, Hyprland scale 1.5). Rendered
at 2×, so zoom 75% × your 100%." — and says so where the window's pixel ratio is not what
that zoom should give. Where Desktop cannot read the monitor's scale, as on another
compositor or an X11 session, it says the scale is not known and why, and Zoom alone applies.

**Settings** also holds **Collie**: every setting the TUI's Settings offers — each default a
Run reads, `proactive`, the extra `models.<harness>` and each `notifications.<kind>` — with
a control that fits it (a choice, a number, a switch, or text), its default beside it, and
the same refusals as the TUI. Both read one list of settings (`src/settings.ts`), so a new
setting shows up in both. These are the Flock's: Desktop keeps them in
`flock-settings.json` beside its chat, and gives them to every Machine through that
Machine's host, never by editing a file over SSH. A Machine is synced each time it
connects and after every edit in Settings, so one out of reach gets an edit when it is
back, the way upgrades reach it. An edit on one Machine's own TUI Settings counts the
same: Desktop takes it the next time it sees that Machine, or when Settings is opened, and
spreads it. Each key is decided by whichever edit was made last, wherever it was made
([ADR-0043](adr/0043-a-shared-setting-is-its-latest-edit.md)); on the first sync a key set
on one Machine only is taken from it, and a key set differently on several takes the latest,
with Settings saying beside it which Machine that came from. What stays each Machine's own
is everything else in its `config.json`: remembered answers such as `linear.team` and
`gitlab.assignee`, `chat_harness`, and `projects.root`, which is a path on that Machine.

Helle makes tokens only in Slack, so its step walks you there: **Open Slack** opens the
Slack app, or Slack on the web where the app does not open; run `/helle token` (the copy
button puts it on the clipboard); press **Create new token** and label it, for example
"Collie"; and paste the token. Desktop asks Helle's `/api/v1/me` about it at once and says
whose it is, or that Helle refused it, and keeps nothing until Helle accepts it. **Skip on
this Machine** stays there for a Machine that goes without Helle.

The Claude login is each Machine's own. **Log in** on that step runs `claude auth login`
on the Machine with `$BROWSER` set to a shim Desktop reads, because Claude Code hands its
browser the URL with its callback port and prints only a paste-code URL. Desktop forwards
that port over the Machine's master and opens the URL in your browser, so approving there
finishes the login on the Machine; the printed URL and a code field are the fallback, for
a browser that cannot reach the callback. Linear's login, which `collie onboard` streams
with its port, is forwarded and opened the same way. Desktop then onboards the Machine
again.

**Remove** runs `herdr machine remove` for that herdr machine, closes Desktop's connection
to it and drops its saved board. It never stops a host, a Run or herdr there, and never
uninstalls Collie. This computer is not in herdr's list, so it has no Remove.

Click a card to select it; clicking it again keeps it selected. Double-click a card, or press
its name, to open its record, which selects the card too and follows its Run on its host for
as long as it is open. A click or double-click on one of a card's buttons does only what that
button does, and a card whose Machine dropped can be selected but not opened. A click on the
board's own area below the header, between cards or on a section heading, lets the selected
card go.

The record takes the board's place in its column, under the header bar and beside the Flock
chat, so you can ask the chat about the Run you are reading while its diff has the column's
whole width — the window's, with the chat collapsed or popped out. What you read is
centred in one of three columns: Plan, Review, Facts and Merge request, like Settings and
Machines, in a reading column of about 80 characters; Evidence and Log in a wider one, with
room for a 120-column log line; and Diff and Terminal across the full width. The page's
header, the record's banner and its tabs sit in the reading column on every tab, so they do
not move as you switch, and a narrower window shrinks each column inside the page's margin
rather than scrolling sideways. The record's back button
returns to the board, which was never taken down: it comes back scrolled where you left it,
its sections open or closed as they were, and the card still selected.

A record outlives its Machine's connection. When that connection is renewed — it dropped,
**Sync now** reopened it, or Desktop upgraded the Machine — the record keeps what it showed,
says above it what the board says of that Machine ("vm-mk is out of reach; showing what it
last said", with the reason, or "vm-mk is reconnecting"), and carries on by itself once the
Machine is back. A record opened before its Machine connects fills in once it does. An
action, the offers, the workflows, a Run's file or Go to pane cut off by a renewed
connection says "vm-mk's connection was renewed before this finished", and **Try again**
sends the action under the same request, so it is done once.

Nothing in the window needs a restart. The board, a record, Settings, the credentials
warning, update news and the chat's turn indicator each keep what they last showed when the
stream behind them fails for any other reason — a host stopped, a refusal, Desktop's own
main process — and say above it, as a warning, what went wrong and when they try again:
after 1 s, then twice as long each time it fails again, up to a minute, and at once again
after anything arrives. **Retry now** tries every one of them at once. A Flock chat that
could not start, say before you logged in to Claude, starts again on your next message.

The record is one of Desktop's **pages**, with **Settings** and **Machines**: each takes the
board's column in the same way, one at a time, so opening Settings with a record open replaces
the record, and back always returns to the board. Opening a page moves focus to its back
button, except that Go to pane leaves it in the pane, and back returns focus to where it was. The header's Settings and Machines buttons
each open their page and show as pressed while it is open; pressed again, they return to the
board.

**Escape** backs out one level: an open dialog, menu or popover closes first, then the
open page, and with no page open Escape lets the selected card go, wherever the focus is in
the window. Escape typed in a field, such as the Log search, stays with the field.

The record's **Plan** tab renders the spec, read whole from the host where it is longer than the
details carry, and lists the tickets, each expanding
in place, read from the host when first opened; a link from one plan file to another opens
that file at the top of the tab. **Review** renders the review, read whole the same way, and lists its findings; a
`file:line` in a finding or anywhere in rendered markdown opens
**Diff** at that line, or a read-only view of the file from the Run's checkout where no
hunk shows it. **Diff** is the Run's branch against its merge base — live while the Run
works, final after — as a file tree beside each file's diff, unified or side by side, kept
as you left it while the record is open. Shiki colours each side of a hunk as one text, so
a comment spanning its lines is coloured on all of them. A file is read from the host when
it is opened, and again when the Run changes how many lines it adds or removes, with no
line cap; a file with more than
500 changed lines, or a binary one, starts collapsed. **Evidence** shows the Run's
verifications as a checklist, those that did not do what they were expected to first and
already open with their output in its terminal colours; then every web link the Run's
Outputs, handoffs, review and findings name, as a card: a Claude artifact by the title its
link was given, the merge request with its state, its pipelines with the head pipeline's
status, and any other pipeline with the status GitLab gives it where `glab` is signed in to its host; its screenshots as a
gallery, a `before` beside its `after` where their names pair them, twelve to a page; its
videos, read and played when asked; its HTML reports, such as Lighthouse, in a sandboxed
frame that runs their scripts in an origin of their own, which may neither load anything
from the network nor navigate away; the logs and files it kept, each read when opened and
searchable; and its metrics as a table. A report that keeps its attachments in files beside
it shows without them. **Log**
follows the end of the Run's log as it is written, with a search that keeps only the lines
that match. **Merge request** shows what the host's merge watch last read — title, state,
pipeline, approvals and comments — with Open in browser. **Facts** shows the files the Run was
given, when it was given any (an image as a thumbnail, any other file by its name, type and
size), its **Agents** — one row per agent the Run started, in launch order, with the
harness, model and effort it ran on — its intent, its steering cards and the card's TaskView as the host sent it. Markdown is rendered with
Comark: tables, Shiki-highlighted code and mermaid diagrams, with anything that could run
and every inline style removed, because agents write it. The view's own policy lets nothing
on a page load from the network, and nothing may move Desktop's window off its own page;
rendered markdown is kept inside its own box. A web link in it opens in your browser, never
in Desktop.

Every link you press in Desktop opens in your default browser, as `xdg-settings get
default-web-browser` names it, where you are already signed in. Chrome, Chromium, Brave,
Edge and Vivaldi are started with `--app=<url>`, so the page gets a window of its own;
any other browser, Firefox included, opens it as an ordinary tab.

Every Machine's host is reached the same way: by running
`collie bridge --as desktop --client <this computer>` in a login shell, here directly and
elsewhere as a channel on that machine's master, so the host is started with the
environment `collie` itself would use, and every operation Desktop makes is recorded as
`desktop`. A second bridge on the same master, started `--as chat`, is the Flock chat's,
so nothing its model does is ever recorded as yours. For a herdr machine on a session other than `default`, the host is handed that
session's socket. Desktop never starts, signals or connects to a host by any other route.
`COLLIE_DESKTOP_COLLIE` replaces how `collie` is run here, as a JSON array.

### The Flock chat

Right of the board is a conversation about the whole Flock, 32rem wide but never more than
40% of the window. It follows what arrives while you are near the bottom, and stays where
you are once you scroll up. Ask what is happening anywhere
and have it act on any Machine: it reaches Collie through the same tools as Native chat,
answered by each Machine's host over that Machine's `chat` channel, and carries out what
you ask at once. Everything it names is `<machine>:<id>`, as in `vm-mk:run-04ab8fe5`; a bare
id is taken where only one Machine has it, and refused with the candidates where several
do. Every action is recorded on its Machine as `chat`, under the conversation
`flock@<this computer>`, with the words you wrote that turn. It has the Herd's read and act
tools except `collie_definitions` and `collie_installation`, and holds one Run at a time,
because those read a Machine's own files, which no host operation hands over. What a Run
is waiting on, who answered what, its merge request, plan and the messages sent to its
agents (`collie_run`, `collie_receipts`), and where work can start (`collie_workspaces`),
are answered by the Machine's own host exactly as its Home's chat would answer them, headed
with the Machine's name. A Machine whose Collie is too old to answer is named with "upgrade
Collie on <machine>", and the others still answer.

It reaches files as you could, and asks first for none of it. On this computer it has
Claude Code's own Read, Glob, Grep, Write, Edit and Bash, naming files by absolute path: its
working directory is Desktop's state directory, where Claude Code keeps the transcript. On
every Machine it has `collie_read`, `collie_glob`, `collie_grep`, `collie_write` and
`collie_edit`, which take the arguments Claude Code's tools of those names take, with a path
written `vm-mk:/var/log/app.log`. That Machine's host answers each over the chat's channel,
never ssh around it. A read gives numbered lines, from at most the first 8 MB and 2000
characters of each line; an image as the image where it is at most 2000 px on its long
edge, and otherwise, like any other binary, by its name, size and type. A glob or a grep
answers at most 100 paths or lines, newest first for a glob, cuts a line at 500
characters, answers what it found after 20 seconds, and says how many it left out; a file
it cannot read is passed by. An edit of a file that is not UTF-8 is refused. A write or an edit is recorded in the
host's `files/operations.jsonl` with the chat's voice, and is refused inside the host's
state directory, links followed, because a Run's state changes only through the host. A
Machine whose Collie is too old for files is told to upgrade. There is no shell on a
Machine.

**Settings › Chat** names the Flock chat's harness and model, for this computer only.
The harness offers `claude` and `pi`, using your own install and login on this computer.
Claude runs through the Agent SDK. Unset, its model is `opus`; a set model such as `sonnet`
runs at medium effort with summarised thinking. None of your Claude settings, hooks, skills
or CLAUDE.md loads.

On Pi, write the model as `provider/model`, for example `openai-codex/gpt-6.1-sol`.
Unset, Pi uses its configured default model and thinking level. Desktop starts `pi --mode rpc`
on its login PATH, with Collie's system prompt appended and its own session directory.
None of your Pi extensions, skills, prompt templates or context files loads. Its own
`read`, `bash`, `edit`, `write`, `grep`, `find` and `ls` tools reach this computer without
asking first. Pi missing from PATH is said in the chat.

Pi reaches Collie's tools, the five Machine file tools and AskUserQuestion through one
streamable-HTTP MCP endpoint on `127.0.0.1`, started on its first session. A random bearer
token protects every request. Only the child process's environment carries the token;
the generated extension reads it there. A private MCP server name keeps your Pi MCP
configuration from replacing these tools; the chat still shows their Collie names. The
endpoint remains until Desktop quits. Its
24-hour tool timeout leaves time for a question click or a slow Machine read. A question
in a turn Desktop starts is answered at once that the human is not in that turn.

A model change waits for the turn under way to end, then the next message continues the
same conversation on the new model. A harness change waits too, then starts a fresh
conversation and clears its model; both chat windows reload it. Earlier conversations
lists the current harness's history. Switching back to Claude shows its own conversations
again. You can ask the chat to read or change these settings through `collie_chat_harness`,
with the same checks as Settings.

Your first message starts the session, and it stays warm between turns. Its session id
and harness are kept in `$XDG_STATE_HOME/collie-desktop/flock-chat.json` (or
`~/.local/state/collie-desktop/`), so a restart resumes the same conversation. Claude Code
keeps and compacts its transcript; Pi keeps its session files under Desktop's `pi-sessions/`.
Desktop reads Pi's current branch and earlier conversations from those files.
The Machine rule, News and card note reach Pi after your words as a bracketed note of
Desktop's own. Reading the transcript back leaves the context out of your bubble and keeps
the card as its pill.

Replies stream in as Markdown, rendered as the record renders it: nothing in it runs or
keeps a style, and a web link opens in your browser. Each tool call is one row — the tool, the Machine it
reached and what it was asked — that opens to what the tool answered, and thinking is a
collapsed **Thinking** you can open. When the chat needs you to choose, it asks with choice
buttons, and goes on when you click; any other permission it asks for is refused. Type
while it is working and Enter queues your message as **Queued** until the turn ends, or
drop it with its ✕. Ctrl+Enter sends it now instead: the turn under way, yours or one of
Desktop's own, is interrupted and your message starts the next.

Paste a screenshot with Ctrl+V, in the docked or the popped-out chat, and it goes with your
next message: a chip above the input with its thumbnail, name and size, which its ✕ removes.
Pasted text still pastes as text. Files copied in a file manager and pasted attach the same
way: they arrive as `file://` URIs, which Desktop's main process reads from disk, and where
the window is handed nothing at all on a paste, main reads the system clipboard instead.
Files dropped on the chat attach too, and the paperclip beside the input opens a file
dialog where several can be chosen. A URI that is not a file on this computer, a directory,
or a file that cannot be read is said in the composer and never becomes a chip. The chips are shared by both windows, so popping the chat
out or back in keeps them, and sending uses them up; a message can be files alone, queued or
sent now like any other. A file over 20 MB, or files over 30 MB together, are refused in the
composer with the reason. Desktop keeps one copy of each file, by its sha256, under its state
directory's `attachments/`. The model is handed your words, then a block of Desktop's own
listing each file's name, type, size and the path of that copy, then each image as an image,
each PDF up to 4 MB as a document on Claude, and each UTF-8 text up to 100 KB as text headed with its
name; Pi receives PDFs by the listing alone. Anything else, or anything larger, is in the listing alone, so the model can read it
there. An image whose long edge is over 2000 px is scaled to 2000 px first, and never up, and the
original is what a Run gets. The message shows its chips at once, and again when the
conversation is read back after a restart; a copy Desktop no longer has shows its name alone. An image
whose size Desktop cannot read, or that is still over 2000 px, goes by the listing alone.
[Cleanup](#cleanup) removes a copy 30 days after it was last used, as Claude Code prunes
the transcripts that name it.

When the chat starts a Run, follows one up or steers one because you asked, the work
carries the files of your message: you need not say so. The model can name others instead —
any file of the conversation, a path on this computer, or `vm-mk:/var/log/app.log` — or `[]`
for none, and a turn Desktop started of its own carries none. A file already on the Run's
Machine is handed over where it is; any other is read, here or from its own Machine's host,
and sent once through the Run's Machine's host, however many Runs it goes to. The host
copies each into the Run's directory before the work starts, where its agents' prompts name
it. A Machine whose Collie is too old for files is told to upgrade, and nothing starts or is
steered there. What the host records of your words also names the files they carried.

Click a card and it becomes a chip above the input ("About: vm-mk › Fix board bugs"): your
next message goes with it, so "this one" means that card, and sending uses it up. Clear it
with its ✕, a click on the board's background, or Escape outside a field; a chat popped out
into its own window clears with it. The message keeps its card: it goes to the model as
Desktop's own bracketed note after your words, never as your words, and stays in the
conversation's history, so "this one" in an old message still means the card it went with.
Your bubble shows that card as a pill ("vm-mk › Fix board bugs") from the moment it is sent,
after a restart and in a reopened conversation alike; a queued message gets its pill once
it is sent. Click the pill to open that Task's record on the board — from a popped-out chat
too, in the board's window — or be told the Task is no longer on the board.

A web address in a message — yours, Collie's or Desktop's — is a link that opens in your
browser, never in Desktop: bare, in `<…>`, as a markdown link, or alone in backticks. One
whose text is its own address is drawn without `https://` and, past 60 characters, with its
middle elided ("gitlab.cego.dk/some-group/some-project/-…9abcdef01234567"); hover for the
whole address. A markdown link keeps its words. Long addresses, paths and ids wrap inside
the message, so nothing in the chat scrolls sideways at any width; only a code block, a
table or a diagram scrolls, within itself. The record's markdown wraps the same way.

News reaches it from every Herd on every Machine as one batch: what matters most first —
decisions, then consequential outcomes, then what is worth trying, then the routine — and
by time within each, a screen's worth, saying per Machine what it left out ("and 7 older
items on vm-mk"). Desktop looks a few seconds after a board changes, and every two minutes
regardless. When the chat is idle, a decision or a consequential outcome starts a turn of
Desktop's own: it shows as **Desktop**, never as you, so anything Collie does in it
carries no words of yours, and its usage is written to `flock-usage.jsonl` beside the
session (data, never a limit). Nobody is there to click in it, so a choice it needs is
asked in its reply and you answer in your next message. News arriving mid-turn waits for
that turn to end; what is worth trying and routine News waits for your next message and
goes with it as context. An item counts as read once the model has it, so a turn that
fails first (a usage limit, an outage) leaves it waiting; Desktop tries again at the next
two-minute look. A Machine whose host does not answer a News look within ten seconds is
said to be unread rather than holding up the rest.

The chat reads each Machine's board from the one the window draws: `collie_herd`, where a
bare id is, the Herds a News look asks and whether a Machine's Collie can take a write all
come from the board Desktop already follows, so no tool call has a host build one. Run
details, News and every write still go to the Machine's host. Every Machine the window
shows is one the chat knows by name, and one with no live board is named with why: still
connecting, and how long Desktop has waited for its first board; out of reach, waiting
for SSO, without Collie or needing a newer Desktop, in its connection's own words; or only
a board Desktop saved, and when. That reason is what `collie_herd`, `collie_workspaces` and
`collie_news` say of it, and what a write to it is refused with ("… Nothing was done on
vm-mk."); a bare id another Machine has is refused while that one cannot be checked. A
Machine whose Collie is older than Desktop's chat is written to by nothing.

The bell turns Desktop's own turns off (and on again); it is on by default, and kept in
`settings.json` beside the session.

**Settings** has the **Machine rule** under **Chat**, for **This computer only**: which Machine each kind
of work goes to, in your own words — "Frontend work is on the laptop, everything else is on
the vm". It is kept in `settings.json` on this computer, and given to no Machine. The chat
gets it with every message, its own turns included, beside the Machines Desktop reaches at
that moment, named as the cards name them, with this computer marked as the one Desktop
runs on, so "the laptop" can mean it. When it starts work it names the Machine from the
rule, unless your message names one, which wins. When the rule's Machine is not reachable,
it says so and starts nothing elsewhere; when the rule does not cover the work, it asks.
An empty rule changes nothing. You can also tell the chat to change it ("from now on,
frontend goes on the laptop") or ask what it is; it saves through the same setting, and
Settings shows the new text the next time it opens. The rule informs the chat's choice and
nothing more: a start that names no Machine while several are reachable is still refused,
and a Run the rule placed on another Machine still opens with Go to pane over that
Machine's own connection.

**Start fresh** (the pen) mints a new session and makes it current; the history (the clock)
lists the earlier ones on this computer, newest first, and reopens one. Either way the
session before it ends: there is only ever one live conversation. **Pop out** moves the
chat into its own window, which follows the same conversation (between turns: a window
the chat leaves would take its turn with it) and opens no board of its own, so no Machine is
reached again for it; **Put back**, or closing
that window, returns it beside the board. **Hide the chat** folds the panel away, and the
chat button in the board's header brings it back.

```sh
cd desktop
bun install
bun run start       # build the view and run Desktop from the checkout
bun run typecheck
bun run test        # Desktop's unit tests
```

## Talking to Collie about a Herd

The Home's right-hand pane is an ordinary **Claude Code** session — or **Pi**, if you
choose it — with Collie's role and Collie's tools. It is focused when the Home opens, so
the next thing you type is a question: no mode to enter, no composer to find, and paste,
history, streaming and compaction are the harness's own, because they always were better
than anything Collie would have written.

Ask about the flock and you get an answer about the flock. Chat reads the whole Herd,
always: nothing on the board narrows what Collie may see. Where there are
more Runs than one answer carries, it says how many it left out rather than answering as
though that was all of them. A follow-up is understood — the conversation is the harness's
own session, running for as long as its pane does. A chat that has to be started again —
its process gone — starts a new conversation rather than resuming the last one, which
would carry that whole history into every turn. Claude's runs on the latest Opus at
medium effort.

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
chosen for next time. When Pi does open it opens a new conversation on fresh Herd state —
there is no handoff, no generated switch summary and no transcript conversion.

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
  Each says what it came to. Steering reaches a finished run's live agent too — "have
  builder merge and tag it" is a `deliver`, with a receipt, and comes back `applied` only
  when it was sent; chat never types into a Collie agent's pane itself. When that agent is
  gone the `deliver` fails and names the follow-up that carries it on
  ([ADR-0041](adr/0041-a-finished-run-still-takes-steering.md)).
- **Collie wanted it, so it waits.** Drift the evaluator noticed, a correction it wants
  to send: the board draws the proposal, and it is confirmed against its id and the hash
  of exactly those actions — by you on the board, or by chat — or declined, and nothing
  changed.

Nothing is yours alone ([`AGENTS.md`](../AGENTS.md), invariant 1). What no Collie tool
does — setting what a Run, or every Run, may do without asking, reconciling a delivery
nobody can account for, recording evidence with `collie verify`, switching the chat
harness — chat runs with the `collie` CLI, through the same validation and executors as
when you type it. A start chat makes names its checkout by a workspace, a path, or just the
repository's name: "monorepo" is the one checkout of that name under the
[Projects root](../CONTEXT.md), opened if no workspace is on it, from the Home's chat and
the Flock chat alike. Two checkouts of one name are refused with both paths. What proves a
Run is chat's to choose too: a start you ask chat for
carries the checks chat chose (`start` with `verify`), and chat adds or withdraws a running
Run's (`set_verification`) at once. Collie runs those commands itself, outside any agent's
permission rules; the merge request lists each one with its command, and you verify the
work there before it lands.
That the rest is really there is a gate: `test/chat-parity.test.ts` walks the CLI's own
command tree and fails on a command with no conversational route, so the list cannot
quietly fall behind the CLI.

Chat confirms and declines as you do. "Confirm it" settles the proposal against its id
and the hash of exactly those actions, as the board does; "no" declines it by id alone; and
chat may settle one on its own judgement. What it reads in a Run's notes or an agent's
output is data, never you asking. There is no action that confirms anything, so a proposal
can never carry its own yes. Everything chat does through its tools is recorded as
`chat:` — which matters because the bridge runs inside the harness's pane and so has a
terminal, and a terminal is what the CLI reads as a person. The origin is stamped by the
entrypoint, not inferred; a `collie` command chat runs in its shell is still read off that
terminal, so it is recorded as yours.

It has the harness's own tools beside Collie's — the shell, files, git. A run it names that
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
without being able to show it, Collie writes that down as news. A Run whose card becomes
Ready to release is one item, keyed by the Run and the revision its checks passed at and
saying the card's sentence; a Run ready when it ends is not also reported as ended. Turn it off with
`"proactive": false` in `config.json`.

What it does **not** do is call a model to find that out. The host looks at each Herd's
Runs every few seconds, whether or not a pane is open, and writes each Run's news to the
Herd its Task is in, or to the host's own Herd for a Task from before Herds were recorded; noticing nothing writes nothing, so an unchanged Herd costs exactly
nothing. Output arriving,
a commit, a step starting, a pane changing and time passing are not on the list, and never
were — a changing pane is not progress.

Several things happening at once is one batch, not one interruption each. It says how many
older items it left out, and those stay waiting rather than being replaced by a single
latest-status line. News whose cause has gone — a halted Run resumed, a question
answered, a finished Run whose work has a disposition (merged, abandoned or superseded) — is dropped from
the next batch rather than told late, and stays in the journal. What one conversation
has read is still news to any other about the same Herd.

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
| `cego.collie.pick`   | Popup picker of workflows; asks what you want, infers the rest, runs    |
| `cego.collie.resume` | Popup picker of runs still going; the host picks the chosen one back up |
| `cego.collie.fork`   | Copy a persona into your layer or this project's                        |

Each action opens the `picker` popup, because that is where a terminal is. The run itself
is not a pane: the picker hands it to the host, which outlives it, and the Control Plane
renders what the host reports. A run therefore
survives the picker closing, the Control Plane closing, and the terminal being detached.

### Why a run stopped

`implement` sends a `blocker` or `major` reported by its builder to reviewers before
starting the next ticket. They review the tickets built so far; later tickets are outside
that review's scope. The same implementer fixes their findings, followed by another
review. Each rally is bounded to four rounds and stops on no progress or an unanswered
blocking dispute. Later tickets start only after the rally settles. When the last review
already covers the finished plan, it is reused; further work gets another review.

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
an older Collie recorded is not read at all; `collie run start` begins the same work again.

## Hand-offs between runs

A Run knows about the long-lived agents of its **lineage** only: itself, the Run it was
started from or whose plan it builds, and so on up. An `implement` given a plan's
`runs/<id>/plan`, however it was started, asks that plan's planner;
another Run's planner or implementer, however recently it was started from the same place,
is never the one asked or handed work.

**A review, to whoever can act on it.** After the synthesis, `review` asks **What next?**:

- **Fix findings** — the live implementer of a Run this review was started from is handed
  them, where there is one; otherwise an implementer on this review's own run applies them
  as a fix round, `disputed` and all, and the fix is reviewed again at once. The rally goes on by
  itself until nothing blocking is left, it stops making progress, or four rounds have run,
  and then asks again. A hand-off offers **Review again** for when the implementer is done.
- **Fix findings in a full implement run** — starts `implement` with the review itself as
  the work source: `review.md` is the spec, the findings are the tickets, and the
  implementer works where the review was pointed — checking out the branch, or `glab mr
  checkout` for a merge request, so the fixes land on that MR's own branch and its merge
  request is updated instead of a second one opened.
- **Post to MR** — only for a merge request target: the review is posted to it.
- **Don't post** — the run ends with its findings.

**A plan that changes under an implementer.** `implement` reads its tickets again after
each one it builds, by name, so what is already built is kept, a ticket added, reordered or
edited since is built as it reads now, and one removed is not built at all. It is not told
about an edit while it is building a ticket. Each reading is recorded, so a replay after a
restart follows the lists that were read rather than reading them again.

**A decision the plan does not cover.** The implementer's prompt names the live planner's
agent and pane and tells it to ask there rather than stopping. Where nobody can answer,
the same prompt tells it to decide and record the decision under `assumptions`, and each
one is listed in the merge request for you. It asks for one authority: an answer in the
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

`~/.collie/user/config.json`, beside your own workflows and personas, all keys optional:

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
  "fallbacks": ["codex", "pi/openai-codex/gpt-5.6-sol"],
  "trust": "auto",
  "permissions": "auto",
  "scope": "local",
  "density": "comfortable",
  "questions": "focus",
  "gitlab_host": "gitlab.cego.dk",
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
[Talking to Collie](#talking-to-collie-about-a-herd).

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
model, effort or scope fails validation before a single tab opens. See
[Authoring](authoring.md#harnesses-models-and-effort) for what each harness accepts, and
[Permissions](#permissions-auto-by-default) for what `permissions` decides.

`fallbacks` ("Fall back to" under Settings) is where work goes once the agent it would run
on has used up its **Subscription**
([ADR-0049](adr/0049-work-goes-to-an-agent-with-usage-left.md)): the first of these with
usage left, in order. An entry is a harness, which runs that harness's own default model and
so never goes stale, or `harness/model`, split at the first `/`, so
`pi/openai-codex/gpt-5.6-sol` is pi on that provider's model. An entry naming a harness
Collie has no adapter for is refused when you set it; a model is checked only when the entry
is used, and one that does not resolve is skipped, with a line in the Run's log saying why.
An entry that draws on the same Exhausted Subscription — pi on `openai-codex` once ChatGPT
is out — is skipped too. The effort the work asked for comes along where the harness takes
it. Empty, the default, keeps today's behaviour: the work starts on its preferred agent, and
the Run's record says when its Subscription resets. It is shared across the Flock like every
setting, and read at every choice, so an edit reaches the next agent. If an agent has run
out and no fallback has room, Collie checks again each minute while waiting for its Output.
Adding a usable fallback then moves the unfinished work to it automatically. The Run's record and
`collie run show` say which agent each step landed on, as in
`codex/default (fell back from claude/opus: session 100%, resets 15:45)`, and the Run's log
gets a line when it happens. Usage never refuses, holds or delays work.

`notifications` turns a kind of toast off: `{"run-done": false}`, and a kind left out is on.
The host raises one when a run finishes (`run-done`), fails (`run-failed`, or
`output-unusable` where an agent's Output could not be used after its repair), asks you
something or parks until you act (`needs-you`), or records a merge request it opened
(`mr-opened`); when a card is something you could go and try (`slice-ready`); and when
Collie corrects a run's drift by itself (`correction-sent`) or gives up on it
(`drift-unresolved`) — each once per run and thing, however often the work is replayed or
its host restarts.

`max_iterations`, `handoff_timeout_ms` and `quiet_ms` are still read and shown under
Settings, but a run of a workflow module consults none of them: `implement` carries its own
ceiling of four review and fix rounds, there is no hand-off between runs to time out, and no
quiet agent is nudged.

`board_quiet_ms` is how long a running run's directories — its own, its agents' and its
evidence — may go unchanged, with no agent of it working and no check running, before its card
reads `…but silent for 9m` and takes the quiet edge. Five minutes by default. Nothing is
nudged and nothing is given up on — it is shown, so a hung run is visible before you notice
by accident.

`compact_at_tokens` is where compaction between pieces of work kicks in — see
[Compaction between pieces of work](#compaction-between-pieces-of-work).

`gitlab_host` is the one GitLab this Machine works against, `gitlab.cego.dk` unless you
change it under Settings, which refuses anything that is not a host name. `collie doctor`
checks glab's login, the token and `git push` for that host alone, and `collie onboard` logs
in and pushes to it; another host glab knows is named in a note and never counts against
the Machine. `GITLAB_HOST`, or `--gitlab-host` on either command, overrides it for one run.

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
again. Before an agent's harness starts, Collie checks whether that harness trusts the
directory the agent will work in, once per directory and harness in a Run. If it does not,
Collie writes `hasTrustDialogAccepted` for that directory into `~/.claude.json`,
which is where claude keeps the answer to its own dialog. The previous file is copied to
`claude.json.bak` in the Collie state dir first, every other project and setting is carried
over as it was, and the new file is renamed into place with the old one's permissions, so
no reader ever sees it half-written. It is still a read-modify-write of a file claude owns:
if a claude session saves in the same instant, that save is the one that loses. It happens
once per directory, so the window is opened once.

A grant, or the reason nothing was granted, is a `trust claude:` line in the Run's
`agents.log`. A `~/.claude.json` Collie cannot read is left alone, and a grant that fails never stops the launch: claude asks in
its own pane instead.

`trust` defaults to `auto`. `never` leaves trust to Claude's own dialog. The old `ask`
setting is accepted as `auto`; Collie's duplicate trust menu has been removed.

If you do let claude ask, nothing breaks: `agent start` reports the agent blocked, which is
not a failure, so the run says which pane wants you and waits. It cannot answer
for you — the dialog shuffles its options between runs, so there is no safe key to send.

## Permissions: auto by default

Most harnesses ask before running a tool call they have no rule for, and they ask in the
agent's own pane — the one place a Run nobody is watching cannot answer. So agents start in
their harness's auto mode, where the harness reviews each call itself instead of asking,
and `permissions` in `config.json` says so. (pi has no tool-approval prompt, so every value
starts it the same way; opencode has no auto mode, so `auto` starts it as `harness` does.)

| Value     | What a Run does                                                                              |
| --------- | -------------------------------------------------------------------------------------------- |
| `auto`    | Default. Each agent is started in its harness's auto mode, where it has one.                 |
| `bypass`  | Opt-in. Each agent is started with its harness's switch past every prompt, where it has one. |
| `harness` | No switch. The harness's own settings decide, and a prompt waits in the agent's pane.        |

Where Claude Code's managed settings — your organisation's, which no flag gets past —
disable bypass mode (`permissions.disableBypassPermissionsMode` in
`/etc/claude-code/managed-settings.json` or a file in `managed-settings.d/` beside it,
`/Library/Application Support/ClaudeCode/` on macOS), a claude agent asked for `bypass` is
started in auto mode instead, and the run's `agents.log` says so.

Know what `auto` buys: the agents run commands, edit files and install things with nobody
asking you, inside the checkout the Run is working in, and the harness's review is the
only check on them. `bypass` takes that check away too. `implement` and
`renovate` are the workflows Collie gives a checkout of their own, so their agents work in
a worktree rather than in yours, and what `implement` does is reviewed before it becomes a
merge request. Every other workflow — `plan`, `review`, a standalone `architecture` — runs its agents **in the
checkout you started them from**, with your uncommitted work in it and neither of those
fences in the way. That is the case to weigh before leaving the default on, and more so before choosing `bypass`.

Set `permissions: harness` in Settings if you would rather answer the prompts yourself, or
`permissions: harness` on a single operation (see
[authoring](authoring.md#harnesses-models-and-effort)) for one that should ask.

An unknown value is refused by Settings. One hand-edited into `config.json` still opens in
Settings, where you would put it right, and starts agents in `auto` until you do.

Trust is unaffected and still answered first: it decides whether the harness will work in
the directory at all, and permissions only decide what it asks about once it does.

## Cleanup

Collie removes what it made once nothing needs it, and only what it can show it made
([ADR-0045](adr/0045-collie-removes-what-it-made-once-nothing-needs-it.md)). The host sweeps
every ten minutes, whether or not a pane is open. A sweep removes:

- **Task workspaces**, an hour after the first sweep or listing that saw their Task
  **Finished**. One herdr has in focus at
  that moment is kept, and so is one holding a pane Collie did not open — your own shell or
  dev server — until you close it yourself. The Home, and a workspace that is no Task's,
  are never closed. The Task's agents close with it, including any of its panes left in
  another workspace. A Task that stops being Finished, because a new Run joined it or a
  steer reopened it, starts its hour again. Continue task, or a Follow-up Run, reopens a
  closed workspace on the Task's checkout.
- **Worktrees** Collie made, once they are **Settled** (see
  [What a run does to your repository](#what-a-run-does-to-your-repository)).
- **Staged module generations** under `~/.cache/collie/entries`, once unused for 7 days.
  Loading a module again counts as using it, and one that is needed after it went is
  staged again.
- **State no Run owns:** a Run's directories under `runs/`, `agents/` and `evidence/`, its
  `stop.`, `hold.`, `parked.` and `notified.` markers and the steering ledgers of its
  agents, once no Run has a row for them and nothing in them has changed for a day. That
  includes what the previous engine left, and `events.*.log`, `plans/` and `runs/.seq`,
  which nothing reads.
- **CLI receipts** under `requests/`, 30 days after they were written.
- **Uploads** under `uploads/`, a week after a front door last asked for them; a Run given
  one holds its own copy.
- **Compaction controls** of an agent no herdr session lists any more, with the endpoint it
  held open.
- **Runner copies** under `~/.cache/collie/runners`, but the running version's and the
  newest.
- **Desktop's own files**, on a computer with Desktop: staged updates, runner copies, usage
  lines, chat attachments unused for 30 days and transfers abandoned for a day, which
  Desktop also removes itself as it starts (see [Collie Desktop](#collie-desktop)).
- **Renovate clones** under the state directory's `renovate-repositories/`, once no Run uses
  one and no checkout of it is left.
- **Tasks**, 30 days after their last Run ended, with every one of their Runs, once nothing
  — a workspace, an agent, a checkout, another Run — needs them.

An entry of the state directory that is no kind Collie knows is listed as kept and never
removed.

`collie cleanup` lists what a sweep would remove now, with each item's size and the total,
and what Collie keeps and why. `collie cleanup --apply` sweeps now; chat can do the same.
Every removal is judged again at the moment it is made, never forced, and recorded in the
state directory's `cleanup.jsonl` with when, what, how big, why and who asked, for 30 days.
Anything a sweep cannot judge is kept, with the reason.

## Usage

Each Machine's host reads how much of its Claude and ChatGPT **Subscriptions** is used
([ADR-0049](adr/0049-work-goes-to-an-agent-with-usage-left.md)), per window: the 5-hour
session, the week, and a model's own week where the plan has one. `collie usage` prints it,
the Control Plane's header names each Subscription's busiest window, Desktop shows it across
the Flock and per Machine ([Collie Desktop](#collie-desktop)), and chat runs the command
when you ask how much is left.

The numbers come from where the harnesses' own `/usage` and `/status` get them:

- **Claude**: the usage endpoint Claude Code's `/usage` reads, called with the login Claude
  Code keeps on this Machine (`~/.claude/.credentials.json`, or under `CLAUDE_CONFIG_DIR`;
  the Keychain on macOS). Collie only reads that login, and never refreshes or writes it:
  once it has expired, the reading says so until Claude Code next runs and refreshes it.
- **Claude agents Collie started**: their status lines report the session and weekly
  windows after every response, and the newest of them wins over an older endpoint reading.
  So while an agent works, the reading is as fresh as its last response.
- **ChatGPT**: Codex's app server, asked through a running Codex agent's own where there is
  one, and a `codex app-server` started for the one question otherwise.

Nothing polls. The host asks only when something wants the numbers — `collie usage`, the
board, Desktop — and calls each endpoint at most once every five minutes; between calls it
answers with the last reading and its age. An endpoint that refuses is left alone for as
long as it asks (five minutes where it does not say), and one that does not answer within
ten seconds becomes a problem; either way the last good windows stand. A window whose reset
has passed counts as unused, whatever was read before it. Each reading says when it was
true, where it came from, or why there is none — a login that expired, Codex not installed
or not logged in. Machines logged in to one account each read it for themselves; a reading
names the account by its id, never its email, because one email can hold a personal plan and
a team seat.

An agent can also run out in the middle of its work
([ADR-0049](adr/0049-work-goes-to-an-agent-with-usage-left.md) D8): Claude Code says it
stopped on its limit, or its status line shows a window at 100%; pi stops on a usage-limit
error; or this Machine's reading says the Subscription is Exhausted for its model. If it has
not written its Output yet, Collie closes its tab — Claude would otherwise carry on in the
same checkout at the reset — and opens a new one in the Task's workspace on the next agent
with room, given the same work with a hand-over at the head of its prompt: what the earlier
agent changed is in the checkout, and where its conversation is. The Run's log says
`build: claude/opus ran out (session 100%, resets 15:45) — continuing on codex/default as
<agent>`, and the Run's record lists both agents, the new one saying what it fell back
from. The new agent takes the old one's place for later work that names it, such as the
next slices of a build. A transient rate limit or an overloaded API moves nothing, nor
does a harness that will not start or is signed out: the Run parks with its reason as
before. Where nothing has room, the agent is left where it is, and the Run waits for it,
parking after its collection time with when each Subscription resets.

Usage is data: it never refuses, holds or delays work.

## Troubleshooting

**A change to Collie has not taken effect.** Run `collie upgrade`, or `~/.collie/setup.sh`
again — either one. Both pull the checkout (`--ff-only`, and a pull they cannot do is
reported rather than forced) and both end in the same `prepare.sh`, so both bring the
plugin link, the runner and shim, the operator skill and the skills up to date. Every step
skips what is already in place, so re-running is cheap: an unchanged checkout is not even
rebuilt. The one difference is the keybindings, which `setup.sh` writes and nothing else
touches — if a binding you expect is missing, `setup.sh` is the one to run.

Nothing already running has to be restarted by hand. The host is replaced by the first
client of the new build, the Control Plane relaunches itself on the new binary, and the
Home chat's Collie tools are answered by the new binary from the next call on. Only a tool
the new build added or renamed needs the chat's `/mcp` to reconnect before it shows up.

**Something is missing and you would rather not find out mid-run.** `collie doctor` checks
every prerequisite at once — herdr and its minimum version, the plugin link, the runner and
the shim's directory on PATH, the skills and harnesses your workflows name,
whether this checkout is behind its remote, which Projects root a Run started from the Home
is rooted at and where that came from (`projects.root` in `config.json`, else `GITTE_CWD`,
else your home directory, which is shown as `!` with the fix of setting `projects.root`),
and whether `glab` is logged in — and prints the command that fixes each. It exits non-zero when any check fails. Helle credentials and a
Linear MCP in Claude Code are reported too, as `!` when they are set up and not working, and
never fail it: see [Optional integrations](#optional-integrations). It also names the
workflows here: every one a user or project entry overrides — which is what a run in this
project would actually do — and every persona that will not load, with why. Nothing is
edited: they are yours.

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
