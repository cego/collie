# Collie — Context

## Glossary

**Workflow** — A TypeScript module saved as `<id>.workflow.ts` whose default export is its definition: its public id, what it takes and gives back, what it declares — hints, outcome, checkout, offers and the agents it prefers — and `run`, ordinary Effect code the host executes as a Run. It asks an agent with `agentWork`, a human with `ask` and another Workflow with `child`, each when the work reaches it, and composes everything else as ordinary TypeScript. Found where it was saved (see **Layer**); a shipped Workflow is one more module and gets nothing a user's does not.

**Operation** — One piece of agent work inside a Run, named by the Workflow that asks for it. The name is its identity: the agent's name, its prompt and Output files and the Activities that make it durable come from it, so it is stable within a Run and differs from every other. It has a role, injected as a Persona, a Harness, a Model, optionally the Skill it starts, and the schema its Output must decode against. An agent it starts gets a Tab of its own in its Task's workspace, labelled with its role; an operation that reuses an agent opens nothing.

**Trust** — A Harness's own answer to "may I work in this directory". Collie grants it for an agent's directory before that agent's harness starts, by default, without a duplicate Collie question. `never` leaves the question to the harness.

**Permissions** — Who decides whether an agent's tool call runs: the harness's own automatic review (`auto`, the default, which starts each agent in its harness's auto mode), no one (`bypass`, which an operator opts into, and which is auto mode wherever the harness's managed settings forbid it), or the harness's prompt in the agent's own pane (`harness`). Trust is answered once per directory; this is decided per agent start, and an operation may name its own mode. Trust is about the directory, Permissions about the calls made inside it.

**Skill** — A named routine the harnesses share. Installed globally by the skills.sh CLI (`npx skills add … -g`) into `~/.agents/skills`, which is the standard location every harness but Claude Code reads directly; Claude Code gets an explicit symlink from the same CLI. An operation names the one it starts, and the prompt is sent as `/<skill> …`: many skills refuse an agent that starts them itself, and only the human's channel may invoke those.

**Persona** — Harness-agnostic instructions injected when an agent starts (e.g. implementer, reviewer). Not a harness-native config file.

**Panel** — The seats a Workflow's definition gives a role (`agents.roles.<role>`): one, or a list. A **Seat** is an agent (harness, model, effort) and optionally the Persona it is started as and the instructions it is told in place of the work's own. `panelOf(role)` reads it and `agentWork({ seat })` sits work at a seat; what a workflow does with the seats is its own. A fork moves or adds seats and keeps everything else the original's.

**Harness** — The agent CLI an operation's agent runs in (claude, codex, opencode, …). Decided with its Model and effort, layer over layer: the user's default, the Workflow's own, the Run's, a scope around the work, the operation's own. Switching it keeps no Model chosen for another; an agent already running cannot switch.

**Model** — The model a Harness is asked to use, decided with its Harness. One the Harness does not take is refused before any Tab opens; left open, it is the Harness's own default.

**Input** — A value a Workflow needs (plan directory, diff target, goal). Only the **Launch flow** infers one, for a human, from context (branch, cwd, earlier plan Runs, glab), and a Run records which of its Inputs were inferred and which were given. An agent's start — chat's Collie tools or `collie run start` — gives every Input explicitly, an optional one as an explicit empty, and a start missing one is refused with what would fill it.

**Attachment** — A file given to a Run beside the words that asked for the work: a
screenshot pasted into the Flock chat, a file a chat found on this computer or a Machine, a
file named with `--attach`. Named by its path on the Run's Machine — a file that is not
there yet is uploaded once, through that Machine's host — and copied by the host into the
Run's own directory before the work it came with starts or the steer it came with is
delivered. Every agent prompt of the Run lists each one with its path on that Machine, and
a Run starts with copies of the attachments of every Run in its **Lineage**. A start,
follow-up or steer a chat carries out takes the attachments of the human's message that
asked for it unless it names others. Not an **Input**: no Workflow declares one, so every
Workflow gets them unchanged. Not **Evidence**: it is what the work was given, not what it
proved. In the Flock chat it is also what the model is shown — an image, a PDF, a text, or
a name, size and path — and Desktop keeps a copy, so the conversation still shows it after a
restart ([ADR-0044](docs/adr/0044-an-attachment-is-uploaded-once-and-belongs-to-the-run.md)).

**Output** — A structured JSON file an agent writes to the Run directory for one operation (e.g. a review verdict + findings). It is decoded against the Workflow's schema before anything believes it, and one that does not decode buys one repair. Workflows read Outputs, never terminal text.

**Herd** — One herdr session: every workspace in it. The scope of the Collie tab, the
conversation, proposals, the budget and elections. Keyed by the canonical path of the
session's socket, never by a directory. A Task records the Herd its workspace is in, and a
Machine's host reads every Herd on it. **Session** keeps its own meaning below — one
workspace — and is not the Herd.

**Machine** — One computer's Collie: one state directory, its one host, and every Herd on
that computer. Known by its **installation id**, which the first host to own the state
directory writes into it and every later host keeps, so two routes to one state directory
are one Machine. Desktop names it by the label of the first enabled herdr machine that
reaches it, or by the hostname for Local, and adds its SSH target where two share a name.
A computer Desktop reaches that has no Collie yet is known by its herdr profile id until a
host there reports an installation id. Not the plugin installation a host serves, which
`identity` calls `root`.

**Flock** — Every Herd on every Machine **Desktop** reaches.

**Local** — The Machine Desktop runs on, reached through a bridge it starts without SSH and
named by its hostname. Otherwise no different from any other Machine.

**Desktop** — The Collie desktop app: one more front door over each Machine's board, which it
reaches through `collie bridge` started as `desktop`. Not "native", which already means
harness-native (**Native chat**) and Effect-native.

**Home** — The Herd's dedicated Collie workspace, owned by a record plus proof: a live
`collie_home` token, or the recorded pane still carrying its recorded `terminal_id`. A
label is never proof. Anything uncertain is `ownership_unknown` and waits for a human; a
`ready` record whose workspace nothing else claims is not uncertain, and is healed. It holds
one tab of two panes: the board on the left at four sevenths, **Native chat** on the
right at three. Only a pane that has gone is reopened, so a layout a human resized stays
where they put it.

**Native chat** — The Herd's conversation, held in an ordinary Claude Code or Pi session in
the Home's right-hand pane. The harness owns the editor, the streaming, the history and the
compaction; Collie owns which harness, which session, and what the model may reach. It is
bound to a session id Collie mints per Herd and harness, never to whichever session ran
last in a directory. Its whole reach is **Collie tools**.

**Flock chat** — Desktop's conversation about the **Flock**: one live per Desktop (earlier
ones can be reopened, never two at once), a session of
the user's own Claude Code driven through the Agent SDK in Desktop's main process, with
**Collie tools** as its whole reach. Its tools are answered by each Machine's host over that
Machine's `chat` channel, and name everything `<machine>:<id>`. Beside each Home's Native
chat, never instead of it.

**Chat harness** — Which native chat Collie opens with, `claude` (the default, on an
existing installation as much as a new one) or `pi`, from `chat_harness` in `config.json`.
It is a launch preference: changing it never stops, replaces or summarises a running
conversation, and never touches the harnesses Runs use. Each harness keeps its own native
history; nothing is carried between them.

**News** — What Collie noticed and the conversation has not been told: the approved
triggers only — terminal outcomes, halts, pending Choices, evidence gaps, repeated-failure
obstacles and unresolved drift. Written from the Run's own record with no model in the
path, so an unchanged Herd costs nothing; deduplicated by causal key, bounded into one
batch that says what it left out. Each Herd keeps one journal of it, and every
conversation keeps its own receipts on it, recorded by the host: what one conversation
read is still news to another. **Sent** is a transport having accepted it and **read**
is the conversation having taken it — only the second settles an item, and a send nobody
can account for stays `uncertain` for a human rather than being retried. **Superseded**
is an item whose cause no longer holds — a halt resumed, a question answered, a finished
Run whose work has a disposition — settled by the host for every conversation that has
not read it; it drops out of batches, an `uncertain` send of it included, and stays in the
journal. A cause that holds again later is news again.

**Collie tools** — What a chat may reach, over Collie's own shared operations. Most read — `collie_herd`, `collie_run`, `collie_workspaces`,
`collie_receipts`, `collie_definitions`, `collie_installation`, `collie_news` — Herd-wide,
and never narrowed by the board's Filter or its Selection, which are what a human is
looking at rather than what supervision may see; the Selection is told to chat with each
prompt and stands in only where a tool was given no Run.
Three write — `collie_hold`, `collie_do`, `collie_propose` — and every one carries out
what the human asked for, at once, over the same closed action set, the same admission
check and the same executors the CLI and the board use. What Collie wants of its own
accord is a Proposal because of where it came from, never because of who confirms it. Reached over a local MCP server by Claude and a generated
extension by Pi, and by `collie tools call` from a terminal. Desktop's Flock chat takes
the same Toolkit's tools that a host's front door can answer, in-process, each answered by
the host of the Machine it names (`desktop/src/bun/flock-tools.ts`).

**Redirect notice** — What a per-workspace Collie pane from an older release shows on its
next launch: one line and "Open Collie". No board, no chat.

**Steer** — One free-form request about a named Run. Requested actions execute directly;
questions receive explanations without changes, and a dry run previews actions. A target
is required. Questions about a Herd are Native chat's, and about the whole Flock, Desktop's Flock chat's.

**Proposal** — A durable, hash-bound set of actions. Explicit requests execute through
this record immediately. Unsolicited background suggestions remain pending.

**Actor** — Who asked for an operation: the front door its channel declared (`board`,
`desktop`, `cli-tty`, `cli`, `chat`, …) and the request id. The host records it in the Run's audit
trail with every start, answer, hold, stop, resume, offer invoked, grant, steer,
disposition and follow-up. `board`, `desktop` and
`cli-tty` are a human; `cli-tty` needs a terminal outside any agent's pane. A channel
reached through `collie bridge` is the front door it was started as, and `desktop` adds
where it came from: the computer it named and the SSH client the bridge saw. A chat's
`collie_do` also names its conversation and carries the human's message from that turn,
attached by the tool host and never by the model.

**Confirmation** — A command naming a Proposal's id **and** its content hash. A yes to a
summary is not consent to a payload nobody read. Anyone may give one — a human at a
terminal or on the board, or chat through `collie_do` — and who did is recorded: a human
is derived by the front door, never claimed by a caller; native chat's bridge is `chat`,
stamped by the entrypoint that serves Collie tools, because it runs inside a harness's pane
and the CLI would otherwise read its terminal as a person. Attribution is audit, never a
gate. No action kind confirms anything, so a Proposal can never contain its own.

**Delivery** — One message to one live agent incarnation, with states `queued` (a boundary
delivery an older Collie held for the agent's next prompt), `reserved`, `deferred` (herdr answered that the
pane cannot take it yet, so it is tried again under the same id), `submitted`,
`acknowledged`, `verified` and the terminal `failed`, `unknown`, `superseded`, `expired`.
They are separate because they are separate facts. A `deliver` with no mode is `now`.

**Dispatcher** — The only code that sends text to an agent. Holds that agent's ledger lock
across the compaction decision, the composition and the send.

**Incarnation** — An agent as one live process, identified by herdr's own `terminal_id` and
`agent_session`. A name and a pane are inherited by whatever takes the role next; neither
names a process. A registry entry without one is never a delivery target.

**Drift** — A recorded evidence–Intent mismatch. `rule` drift Collie establishes itself;
`semantic` drift is judged against bounded actual evidence. Nothing passes on an absence.

**Correction** — A Delivery caused by Drift, counted against Authority. `correction_submitted`
on send, never `corrected`: sending text is not the work changing.

**Manual override** — An incarnation that received input Collie did not send. Automatic
corrections to it stop until an explicit `run clear-override`; nothing times it back on.

**Disposition** — What became of a Run's work, which is not how its execution ended. Recorded by a human beside the Run's status and never over it — `merged`, `abandoned` or `superseded`, with the merge request, commit or Run that backs it up. A Run that failed still failed; its disposition says whether the work landed anyway. Append-only, so a correction keeps what was believed before. Nothing to do with **Delivery**, which is one message to one agent.

**Verification** — An independently collected command result bound to the tree it ran on,
before and after. A result whose snapshots differ is `unstable`, never `pass`. An agent's
statement about tests is a **claim**, and is shown as one.

**Card** — Collie's record of one slice of work: what was asked for, what changed,
what backs it, and what nobody checked. Its **readiness** — `claimed`, `inspect-ready`,
`verified` — says how far the evidence goes and no further.

**Significance** — Whether a Card or a **News** item is worth interrupting a human for,
decided by rules over facts: `decision` > `consequential` > `try-it` > `routine`. A
narrative never raises it.

**Hold** — A Run under a hold starts no new work until a human releases it. It takes effect at the Run's next boundary, so what is already running finishes. Nothing lifts a hold at a time.

**Conversation** — Scoped to one Herd (Native chat, in its Home) or to the Flock (the
**Flock chat**, in Desktop). For a Herd, also the durable journal of human and Collie turns, plus the turns
the board starts (`event`) when something meaningful changes — recorded as the board's, never
as the human's. Redacted for credential-shaped values, bounded to 500 turns and 30 days, and
never a worker transcript.

**Follow-up Run** — A child Run started from a finished one to act on its outcome, reusing
its worktree under guards. It is how new steps start: a Workflow of its own, with its own
Intent and evidence. Telling a finished Run's live agent something is steering, not a
follow-up (see **Reopened**, ADR-0041).

**Intent** — A Run's goal, the Constraints its work must respect, and the Authority delegated to Collie over it. Versioned; v1 is written at start from the workspace's defaults, the work source's own text and what was named at launch, and amended by an explicit request, and, in a Run on a worktree of its own, by its own `plan/SPEC.md` as its constraints change (ADR-0036). Everything Collie says about drift is a comparison against it; what imported Runs recorded stays readable.

**Constraint** — One thing a Run's work must respect. `kind: rule` is checked by Collie itself; `kind: semantic` is judged. `severity: block | warn`. Its `source` says where it came from — `human`, `workspace-default`, `parent` or `plan` — and a `plan` entry carries the file, heading and line it was read from. Text is evidence: no Constraint, wherever it came from, grants Authority.

**Authority** — What Collie may do to a Run without a new request: correct drift, send at a work boundary or interrupt, stop the Run, and how many corrections a constraint gets. Per Run, correcting drift at a work boundary is on by default; every other grant is off and is set by an explicit command or request. No grant is ever inferred from repository content or worker output. Model-call usage is recorded per Run and per Herd but is not an Authority: it is data, and never a quota that blocks work.

**Run** — One execution of a Workflow: its Inputs, its operations' Outputs and its status, kept as an audit trail. The host holds it. A restart or a resume re-enters the Workflow's current code and reuses every Activity already done, so finished work is not done again and a pending question is still pending; a Run whose code has since changed shape has no such promise, and one whose module is missing waits, naming the file. Nothing the previous engine recorded is carried over (ADR-0027). Its **slug** — `<workflow>-<what it is named after>` — names its agents, its tab and its row on the board, and for a mutating Run it is named after the task half of the Worktree's branch — the branch without the login it is namespaced under — so two Runs on different work can never read as the same row.

**Task** — One piece of work a human is doing, and the Runs it takes: a plan, the
implementation it chains into, the review of that. Recorded on every Run at creation and
inherited by chains, follow-ups and resumes, so membership is a fact rather than a reading
of a label — two Tasks may share a project prefix, and a workspace renamed by hand is
still its Task's. A Run started fresh is a new Task, unless it is about a branch an open
Task's checkout has out — the branch it is placed on, or the one its diff target names —
and then it is that Task's: one workspace per Task. Anything else joins a Task only by an
explicit **Continue task**.

**Task workspace** — The herdr workspace a Task's Runs, tabs and agents live in. One per
Task, made and focused when its first Run is admitted, on the checkout that Run is given,
and kept when the work is finished until the human closes it. Its label is inferred once, at creation — `<Project or theme> | <what
this work is>`, from the work and from the names already live in the session — and is
display only: a label never decides membership, and a label a human changed is theirs,
never written again. It is where Collie scopes a Run lookup: a workspace that is not a
Task's narrows nothing. It gives no file or branch isolation — that is the Worktree's job.
A stop closes only its Run's agents' panes, and its own shell tab is never handed to an
agent, so it outlives them. One herdr has dropped anyway is reopened on the Run's checkout
at the next launch, and the Task records the new id.

**TaskView** — One Task as the board draws it: name, project, state, the step glyphs, one
plain sentence about what is happening, its age, drift, hold, pending **Decision**, agents,
children, branch, merge request and disposition. Built by one function from the Runs the
host reports, the live agents and what each Run left in its directory, so the Home's cards, the one-screen text view and
`collie --json board` are the same model rather than three readings of it. A Run belonging
to no Task is a TaskView of its own.

**Decision** — What a Task is waiting on a human for, and one of the two things that put
it in **Needs you**: a **question** a Run asked, a **Proposal** Collie made, or an evidence
**gate** asking which verifications this Run is to be held to. All three are answered on
the card, from the CLI or from chat, and survive the board closing.

**Stalled** — The other way into **Needs you**, and the one with nothing on the card to
answer: an agent is waiting for a human in its own pane — at its harness's own dialog,
which herdr reports as a `blocked` agent — or a Run parked because its agent's pane would
not take a prompt. Either way the work has stopped, so the card says which pane to go to
rather than what the step was doing.

**Working** — A Task something is actually doing: a Run the host holds that has not
settled, or a **Reopened** Run whose agent herdr reports working. The board's third
section, under Waiting on you.

**Waiting on you** — A Task whose work has ended without **landing**, and which nobody has
asked you about: an implement Run that succeeded and whose merge request is open, a plan
that is ready to implement, a Run that failed or was stopped with a branch or merge
request behind it and has neither been resumed nor disposed of. The board's second
section, under Needs you and over Working, because most of it is work a human can ship
now; **Ready to release** leads it. Not a **Decision**: a Decision is Collie asking; this is work in your hands that
has not been mentioned. A Run that ended with nothing to file — no branch, no merge
request, no plan, no question — has **Landed** and is not waiting on anyone.

**Ready to release** — A Waiting on you Task whose leading Run succeeded, whose merge
request is open, and whose checks passed: every check Collie collected passed at the
revision the merge request's branch is at, and the forge's pipeline, where Collie could
read it, passed too, with nothing failing or still running. Its card says what is ready,
where, that the checks passed and what the human does next. An open merge request whose
checks failed, are running or were never run is still Waiting on you, and its card says
which.

**Reopened** — A finished Run one of whose agents was sent a steer Delivery after the Run
finished. Not a status: the Run still reads `succeeded`, `failed` or `stopped`, because
that is how its steps ended. Derived from the delivery ledger and herdr's agent state, so
nothing records it. Its card is in Working while that agent works and in Needs you while
it is blocked, then stands on its own facts again. Steering reaches a finished Run's
agents for as long as one is alive; a gone pane is the Follow-up Run's job (ADR-0041).

**Landed** — What a Task's work has done once it needs nothing more from anyone: a
**Disposition** was recorded — merged, abandoned or superseded — the Run succeeded at a
Workflow that produces nothing to land, such as a review, or it ended with nothing anyone
could file: no branch, no merge request, no plan, no question. A Task whose work has landed
is **Finished**, the board's last section.

**Held** — A Task whose Runs are under a **Hold**, drawn as a `⏸` line under its sentence
and lifted by a human.

**Session** — One herdr session and one workspace, taken together. It is the
scope of a Control Plane tab and of a register file of live agents, which holds one entry
per agent for every Run started there. One workspace, always: a mutating Run's checkout
does not take it out of the Session it was started in.

**Lineage** — A Run, the Run it was started from, that Run's own, and so on: a child's
parent, or the Run whose `runs/<id>/plan` an `implement` builds, however it was started. The only Runs whose agents
a Run's agents are pointed at.

**Hand-off** — What one Run's agent is told about a live agent of a Run in its **Lineage**:
the implementer's prompt names the pane of the planner of the plan it was started from and
tells it to ask there rather than stop, and with no planner live in its lineage, to decide
and record the decision under `assumptions` in its Output. Another Run's agent in the same
role is never named, however recently it was started from the same place. Nothing is typed
into another Run's pane on its behalf.

**Worktree** — The checkout a mutating Run owns: one per branch, because git allows
exactly one worktree per checked-out branch. The branch names the work rather than the path
to it, and new work is generated as `<GitLab login>/<task>` rather than asked for, so two
Runs on different work can never key the same checkout
([the order it is resolved in](docs/cli.md#start-a-run)). Only the Run's cwd moves; its tabs stay in
its Task's workspace and are `cd`-ed into the checkout, because a Run belongs where its
Task is (ADR-0006). A Workflow declares one — `checkout` in its metadata — and the host
cuts it at admission, before the Run exists, from the checkout the Run starts from: a
directory that is not a git checkout is refused, named. `implement` and `renovate` declare
one; `plan`, `architecture` and `review` declare none, and the `implement` they chain into
is placed by its own declaration, in the same Task. A Renovate Run's is the one that holds
no branch — see Renovate Run.

Two managers, and a Run records which: Collie makes the checkout with `git worktree add`
by default, and `--input workspace=new` asks herdr for it instead, which opens it as a
workspace of the Run's own — or, for a fresh Task, as the Task's. It outlives the merge request and is removed only once **Settled** —
a git-managed checkout with `git worktree remove` then `git branch -d`, and the Run's
tabs whose shells sit inside it closed with it; one herdr has a workspace open on through
`herdr worktree remove`, whoever made it, so herdr never lists a checkout that is gone.

A Run records the branch, the path, its manager, whether Collie created it, and the
moment git wrote the checkout — which is what tells Collie's own checkout from one a
human later made at the same path on the same branch. Where herdr opened a workspace for
it, that workspace's shell tab is left where it is, as a Task workspace's is. A checkout a
human made is never removed.

**Settled** — A Collie-created Worktree that holds nothing which exists only there: the
tree is clean, it holds no commit that is not on the remote already, nothing is working in
it or could be resumed in it, and its merge request is merged or closed (or its remote
branch is gone). "No commit of its own" is the branch's upstream where it has one, and the
default branch where it does not — a branch merged and deleted loses its upstream ref to
the next `git fetch --prune`, and requiring one would make the gone-branch case
unreachable. Only then is it removed, through herdr, and only ever without a force flag:
git's own refusal to drop a dirty or unmerged checkout is the last guard, so a wrong
judgement can fail to clean but never delete work. Removal is never forced whichever
manager does it. The conditions and their order are canonical in `src/worktree.ts` and
`docs/internals.md`.

**Renovate Run** — One execution of the `renovate` Workflow: one repository, from claiming
it in Helle to checking it off in Linear. Its Worktree is detached and roams — it holds no
branch of its own and moves across the Renovate Bot branches it merges, pushing each with
an explicit refspec — so the operator's own checkout is never touched. A Renovate branch
another registered Worktree holds is reported and left alone, never taken and never reached
around with a detached remote-tracking ref.

**Renovate issue** — The one Linear issue a team renovates against: a checklist with one
entry per repository, unchecked when that repository's Renovate Run starts and checked off
when it ends, with that Run's merge request links and outcomes. A Run binds to it at
startup and writes to that issue for the rest of its life, however long it waits in Helle
and whatever cycle it rolls into. Updates are read-modify-write and never rewrite a line
the Run did not add, because several Runs append to one description.

**Renovated with exceptions** — How a Renovate Run ends when every merge request is
accounted for and the release succeeded, but one or more updates were deferred with the
operator's approval. The exceptions are named in the checklist entry. An unresolved
blocker is not an exception: it leaves the entry unchecked and the Run open.

**Layer** — Where a definition is looked up, later wins by name. A Workflow is one `*.workflow.ts` entry, found project `.collie/workflows/` first, then the user's `~/.collie/user/workflows/`, then the installation's `workflows/`; a broken override is reported, never fallen through. A Persona is Markdown, found the same way: the project's `.collie/personas/`, then the user's `~/.collie/user/personas/`, then the installation's `personas/`. Forking takes a baseline definition into a later Layer.

**Override** — A Persona that declares `extends: <name>` and changes only what it names; everything else still follows the parent in the Layer below. A file without `extends:` replaces the whole Persona, and a full copy records `forked_from_hash` so a parent that has moved on can be marked stale. The merge rules are canonical in `src/definitions.ts` and `docs/authoring.md`. A Workflow is overridden by an entry with the same id, and customised by importing what it keeps.

**Fan-in** — Combining several parallel Outputs into one: an operation handed the other operations' Output files, which reconciles them itself. Nothing unions findings for it.

**Synthesis** — What the fan-in over reviewers writes, or a lone reviewer writes itself: one review of the change, deduplicated across models, disagreements settled from the diff, plus a `summary` and the findings it `dropped` with a reason for each. It is rendered to `review.md`, which is what a human reads and what a review may post. It is the loop's gate: the fix sees the Synthesis, never the raw reviews.

**Disputed** — A finding the implementer declined, with its reason. The reviewers are shown the reason, and a disputed finding no longer drives the loop, so the Run converges and the human decides. A reviewer who can answer the reason raises it again with a `rebuttal`, which puts the finding back in front of the implementer.

## Baseline Workflows

What each is for, what it needs, and how they chain: `docs/workflows.md`.

- `plan` — interviews the human, then writes `SPEC.md` and one ticket per slice into its Run's plan directory (ADR-0002).
- `implement` — builds from a work source, reviews what it built with the same pass `review` runs, loops on the findings, and opens or updates the merge request last, only where the evidence is there. No architecture or simplification pass: those are work the change asks for, not work every Run does.
- `review` — standalone; you pick the target; one complete review, and a synthesis that reconciles the reviewers where more than one axis is asked for.
- `architecture` — runs the architect over the project and reports into its Run's plan directory.
- `renovate` — claims the repository in Helle, merges or accounts for every Renovate Bot merge request, tags and watches the release, and records the result on the team's Renovate issue.

**Outcome** — The kind of result a Run has to prove, and the evidence that closes it: a feature names what it built, a bug reproduces before it is fixed, a refactor preserves behaviour, an investigation reaches a supported conclusion and may have no patch, docs run what they document, a migration proves it can go back. A Run nobody classified is `unspecified` and proves only its approved verifications — never a feature by default.

**Approved set** — The verifications Collie may run itself for one Run, each bound argument for argument: the ones given with the start (`run start --verify`, or chat's `start` with `verify`), else `.collie/verify.json` in the project, else the checks remembered for the checkout's remote (`~/.collie/user/verify/<host>/<path>.json`, written by `run intent remember`, or chat's `remember_verification`), else `~/.collie/user/verify.json`, settled at start and kept with the Run as its grant — its Intent's `run_verification`, or the host's record for a workflow module's Run. A plan spanning repositories is held to each repository's own `.collie/verify.json` or remembered checks. A start of a workflow that declares `verifies`, whose outcome needs the set, is refused as `invalid_input` when nothing is approved, before any Run exists. From then on that grant is the set, amended only by `run intent verification` (chat's `set_verification`), and a Run whose grant is withdrawn to nothing stops where it asks for the set. An agent may `collie verify` anything; only the approved set is what Collie runs at the gate.

**Evidence** — A Verification collected at a revision. An Output field saying the tests pass is a claim, and is shown as one. The gate before a merge request reads evidence, never claims.

**Baseline** — A check that failed at the gate, run once by Collie where the Run's branch leaves the default branch, in the Run's own checkout. One that fails there too, and still fails, is reported as failing before the Run's changes: never a pass, and never handed to the implementer to fix.

**Check pass** — One run of an approved check by Collie, with why it runs: `gate` on the
Run's branch, `baseline` where the branch left the default branch, `recheck` on the same
tree to rule out a flake, `fix` after gate fix N, `finish` at the Run's end, or a plain
`check`. The pass is the Workflow's declaration, never read off its id. While it runs, the
card and chat say the check, the pass, how long it has run against how long it usually
takes, and where its output is being written (ADR-0042).

**Obstacle** — What is identifiably in a Run's way, in one sentence: a command failing several times in a row the same way. It is shown to the human and given to the next prompt so the approach can change. It stops nothing.

**Slice** — One item of a list of work — a ticket's build — known by its name, never by where it sits. It has its own prompt and its own Output, runs on the list's one agent, and is handed only its ticket and a few lines of fact about the items before it — their commits and what they verified, never their transcripts. A replayed or resumed Run reuses the items already done and does only what is left.

**Choice** — A question a Run asks the human with `ask`, from a closed set of options: what the answer does next — start another Workflow, prompt an agent, post a review, stop — is the Workflow's own code. An answer outside the options, or a second answer to one already answered, is refused and starts nothing.

**Chain** — Starting another Workflow from a Run, with `child`: typed input decoded against the child's schema before it is admitted, a stable invocation name, and the child recorded as this Run's. Replaying the parent reuses the child it already has. A fan-out chains several at once, one per repository a plan touches; see Repo run.

**Plan directory** — The `plan/` folder inside a Run: SPEC.md and the ticket files. It is the hand-off from `plan` to `implement` and never lives in the repository. Every ticket names the repository it changes with a `Repo:` line: a path under the Run's root, `.` for the root itself, never absolute and never containing `..`.

**Projects root** — The one directory every checkout a human works in lives under: the gitte folder by default, else a configured one. A Run started from the Home is rooted there, because the Home has no checkout of its own and the human names none; a plan's `Repo:` lines are then paths under it.

**Repo run** — One child Run of a fan-out, owning one repository's branch and merge request and building only the tickets whose `Repo:` names that repository. Every Repo run of one plan uses the same branch name.

**Wave** — The Repo runs a fan-out starts together: those whose tickets are blocked by no ticket of a Repo run still going. Ticket order inside a repository is the Repo run's; cross-repository order is the wave's. A plan whose repositories block each other in a cycle has no wave order and is refused, as is one whose "Blocked by" line names something that is not a ticket of the plan, or which numbers two tickets the same so that such a line cannot say which it means.

**Deferred** — Architecture candidates the architect chose not to apply unattended, kept in the summary for the human.

**Collie tab** — The Herd's own tab, labelled `🐕 Collie`: the Control Plane rendered
as an application (ADR-0005). One per Herd, in the Home (ADR-0009). Effect produces its state and Solid renders
it; a pane that cannot start the renderer falls back to the one-screen text view.

**View** — What the Collie tab's nav switches between, one at a time, each a projection of
state Effect produces and none of them read until it is first shown. **Runs** is this
Session's live work: agents, active Runs, finished Runs. **History** is every finished Run
of this checkout whatever session it came from — where "review !123 again next week" comes
from once the original Run is gone. **Workflows** is every Workflow and Persona with its
layer, Inputs, decisions and whatever validation says is wrong with it. **Settings** is the
defaults and remembered values in `config.json`, and whether the harness is trusted here.

**Launch flow** — The two questions between "run a workflow" and a Run: which Workflow, and
what the human wants, in their own words. The words fill the Workflow's launch Input — the
one field it hints with `goal`, `work-source`, `diff-target` or `gitlab-repository` — where
they are a value of its kind, and otherwise say where the work is; every other Input is
inferred or left empty, and a start that still lacks one is
refused with the reason rather than asked again. Where the work happens is never asked:
outside the Home it is the checkout the human is in, and from the Home it is the
**Projects root** or the checkout the words point at. What it inferred is shown in one line
before the Run starts. It is the human's front door only: an agent's start is given
everything explicitly (see **Input**). Nothing about the Run's questions — those
are asked when the Run reaches them, with the work they decide about in front of the
human. One set of components, two placements — a popup pane for the herdr action, and inline in the
Collie tab for `＋ New run` — because a question a human answers is a component. A
question a Run answers is a file in its Run directory, and those two never converge.

**Selection** — The Task whose record is open on the board, and what chat means by "it"
([ADR-0012](docs/adr/0012-the-boards-selection-is-an-explicit-chat-input.md)). Held by a
stable id — a Task id, a Run id — never an index, because the sections re-sort under it.
Changing it is a change in what is read, not in what is true: the record and the one merge
request behind it are produced for the Selection, and a read superseded by a newer one is
interrupted rather than finished. An action is never applied to it: every action on the
board belongs to the card it is on.

**Focus** — What the Collie tab is being looked at as: the showing View, every View shown
at least once, the Selection, and whether the panel's log tail is open. It is what decides
how much has to be read, so it is state rather than a render-local signal, and it is plain
data: one function says where a focus command leaves it, and one says what a new one means
for the reads behind it — whether the last board may be reused, and whether the merge
request must be read past its cache.

**Control Plane** — The tab a Session keeps as its control surface, one per workspace, and
the only pane Collie keeps open. It is a view over the run dirs and the register, always the
workspace's first tab, and holds no state of its own, so closing it loses nothing. Its Runs
view is drawn at a **Scope**. What it shows and what its keys do: `docs/using.md`. A Run's
own tabs follow in the order its agents started, whatever the Workflow is called, and
Collie never moves a tab.

**Filter** — What the Home board shows: `all`, one workspace, or one Run. A view property
and nothing more — supervision never reads it, so a Run outside the current filter is still
driven, still checked and still corrected.

**Scope** — `local`, this Session's own workspace, or `all`, every workspace of this herdr
session that Collie has a Run, an agent or a history in. It is what a Run lookup searches
and never what a Session is: the register a Run's agents are written to and starting a
Workflow stay this Session's, and a hand-off stays in the Run's **Lineage**. The board no longer has one — it is the whole Herd's, one card per Task
([ADR-0013](docs/adr/0013-the-board-is-cards-of-tasks.md)) — so the `scope` default in
`config.json` is read at launch and narrows nothing a human sees.

**Work boundary** — The moment immediately before a reused agent that has finished its
previous work is given the next piece: a Workflow's next operation on the same agent, a
fix round's next iteration. It is where Collie reads that
harness's current-context measure and, at or above the user-wide `compact_at_tokens`,
asks it to compact natively before sending anything. Not a liveness nudge, not a
mid-step recovery message, and not a human typing in the pane — none of those are work.
A freshly launched agent has no boundary before its first piece of work. What Collie
does with each outcome, and what a five-minute unresolved attempt stops:
`docs/using.md`.

**Notification** — The only channel from an unattended Run to the person who started it, so what is not worth interrupting for is not sent at all. One title shape — `<repo> · <slug> <what happened>` — one taxonomy in `src/notify.ts`, once per `(run, kind, step)`, and never a reason for a Run to fail.

**Host** — The one background process that runs work for a state directory. CLI, board and chat all reach it over the same local RPC, and closing any of them leaves its work running. It owns the directory under `host.lock`, keeps its Runs in SQLite, and on restart hands every accepted Run back to the engine, so completed work is reused rather than repeated. A client of another build is told to restart it before `HostRpcs` (ADR-0015); `FrontDoorRpcs` serves any build (ADR-0038).

**Ownership** — Who holds something that must have one owner. A claim stands while its process answers and is still the one that wrote it, and one whose process answers but whose identity cannot be read stands too: "I could not tell" is not permission to take over. It decides which process may be the host for a state directory; canonical in `src/lock.ts`.

**Attention** — What a Run wants from whoever is watching it, as one classification both
front doors render: a pending question, drift Collie could not settle, a completed Run, an
interruption, or nothing yet.
Additive to the lifecycle status rather than a redefinition of it — `waiting` still means
"has not settled" for every existing wait and fan-out — and derived from what the Run
already recorded: the question it is asking, the drift it left, and how its execution
ended. It carries a stable reason code, the sentence a human reads and the actions that
are valid now. What none of the recorded facts settle is said to be unsettled, never guessed.
`collie run wait --until attention`, `run show` and a card's own record are three readings
of this one value; canonical in `src/attention.ts`, with the reason codes in
`docs/cli.md`.
