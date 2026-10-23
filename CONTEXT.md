# Collie — Context

## Glossary

**Workflow** — A TypeScript module saved as `<id>.workflow.ts` whose default export is its definition: its public id, what it takes and gives back, what it declares — hints, outcome, checkout, whether it closes after reporting, offers and the agents it prefers — and `run`, ordinary Effect code the host executes as a Run. It asks an agent with `agentWork`, a human with `ask` and another Workflow with `child`, each when the work reaches it, and composes everything else as ordinary TypeScript. Found where it was saved (see **Layer**); a shipped Workflow is one more module and gets nothing a user's does not.

**Operation** — One piece of agent work inside a Run, named by the Workflow that asks for it. The name is its identity: the agent's name, its prompt and Output files and the Activities that make it durable come from it, so it is stable within a Run and differs from every other. It has a role, injected as a Persona, a Harness, a Model, optionally the Skill it starts, and the schema its Output must decode against. An agent it starts gets a Tab of its own in its Task's workspace, labelled with its role; an operation that reuses an agent opens nothing.

**Trust** — A Harness's own answer to "may I work in this directory". Collie grants it for an agent's directory before that agent's harness starts, by default, without a duplicate Collie question. `never` leaves the question to the harness.

**Permissions** — Who decides whether an agent's tool call runs: the harness's own automatic review (`auto`, the default, which starts each agent in its harness's auto mode), no one (`bypass`, which an operator opts into, and which is auto mode wherever the harness's managed settings forbid it), or the harness's prompt in the agent's own pane (`harness`). Trust is answered once per directory; this is decided per agent start, and an operation may name its own mode. Trust is about the directory, Permissions about the calls made inside it. Under `auto`, a Claude agent's review is told which Run it serves, the branch that Run created where the forge says it is unprotected, the words a human started it with, and each step's **Clearance**. Collie adds no permission rules of its own (ADR-draft-what-a-run-authorises-reaches-auto-mode).

**Skill** — A named routine the harnesses share. Installed globally by the skills.sh CLI (`npx skills add … -g`) into `~/.agents/skills`, which is the standard location every harness but Claude Code reads directly; Claude Code gets an explicit symlink from the same CLI. An operation names the one it starts, and the prompt is sent as `/<skill> …`: many skills refuse an agent that starts them itself, and only the human's channel may invoke those.

**Persona** — Harness-agnostic instructions injected when an agent starts (e.g. implementer, reviewer). Not a harness-native config file.

**Panel** — The seats a Workflow's definition gives a role (`agents.roles.<role>`): one, or a list. A **Seat** is an agent (harness, model, effort) and optionally the Persona it is started as and the instructions it is told in place of the work's own. `panelOf(role)` reads it and `agentWork({ seat })` sits work at a seat; what a workflow does with the seats is its own. A fork moves or adds seats and keeps everything else the original's.

**Harness** — The agent CLI an operation's agent runs in (claude, codex, opencode, …). Decided with its Model and effort, layer over layer: the user's default, the Workflow's own, the Run's, a scope around the work, the operation's own. Then, if its **Subscription** is **Exhausted**, it moves along the **Fallback chain**. Switching it keeps no Model chosen for another. An agent already running cannot switch; a **Fallback** gives its work to a new agent instead.

**Model** — The model a Harness is asked to use, decided with its Harness. One the Harness does not take is refused before any Tab opens; left open, it is the Harness's own default.

**Subscription** — The paid plan a Harness's login draws its usage from: `claude` (Claude Pro, Max or a team seat, through Claude Code's login) or `chatgpt` (ChatGPT, through Codex's login). It belongs to an account, not to a Machine. Machines logged in to the same account share one Subscription. Each of those Machines reads it for itself. An account is known by its id, never by its email alone, because one email can hold a personal plan and a team seat: Claude's by its organization and account, ChatGPT's by its account id and the login's email, because that id is the workspace's and every seat in it shares it. `pi` and `opencode` draw on the one their model's provider names (`anthropic/…`, `openai-codex/…`). Any other provider draws on nothing Collie reads. Not model-call usage, which Collie records as telemetry.

**Usage reading** — A Subscription's windows on one Machine. Each window has its length (a 5-hour session, a week, a week of one model), how much of it is used, and when it resets. A reading also says when it was read and from where: Claude Code's own usage endpoint, Codex's app server, or the status line of a Claude agent Collie started. The host calls each endpoint at most once every five minutes, and backs off when one refuses. Running agents' status lines keep the reading current between calls. Every door asks the host. A window whose reset has passed counts as unused.

**Exhausted** — A Subscription with a window that applies to the Model and is used up: fully used, or reported by its source as reached (a spend limit, Codex's `rateLimitReachedType`). Its reset must still be ahead. A Subscription with no reading is never Exhausted. Being Exhausted never refuses or delays work. It only decides which agent does the work.

**Fallback chain** — The human's `fallbacks` setting: an ordered list of `harness` or `harness/model` entries, shared across the Flock. It is tried after whatever the work itself prefers, including a Workflow's own `otherwise`. It is empty by default. The **Flock chat** has a chain of its own, `chatFallbacks` in Desktop's Settings, for this computer only. It is tried after the chat's own harness and model, judged by the same rules.

**Fallback** — Work moved to the next agent with room because its agent's Subscription is Exhausted. If that is known before the agent starts, the recorded choice is simply another agent. Mid-work, Collie stops the agent and, once it is **Quiet**, starts a new one on the same operation, with the same prompt and a hand-over. The hand-over says the checkout holds what was done and where the earlier transcript is. The new agent also takes the old one's place for later work. A Fallback is recorded with what it fell back from and why. In the **Flock chat** a Fallback keeps the conversation on another model of the same harness. On another harness it starts a new conversation, and Desktop's hand-over says where it came from and where the earlier transcript is.

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
restart ([ADR-0046](docs/adr/0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md)).

**Output** — A structured JSON file an agent writes to the Run directory for one operation (e.g. a review verdict + findings). It is decoded against the Workflow's schema before anything believes it, and one that does not decode buys one repair. Workflows read Outputs, never terminal text. Collie waits for it against the agent's idle time only: while herdr reports the agent working or blocked, a question it asked is open on the Run, or a `collie verify` it asked for waits while its Machine is **Short of memory**, the budget does not run (ADR-0062). When the budget runs out, the Run is parked and keeps waiting: an Output written later is collected without a resume (ADR-0062, amended 2026-10-19).

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
`identity` calls `root`. herdr's machine list (`herdr machine list`) is the list of
Machines, for the CLI as for Desktop: adding a Machine there is all it takes to reach it.

**Short of memory** — A Machine whose available memory is under `memory_hold` percent of
its total (10 by default; 0 never), or, on Linux, whose memory pressure (`full avg10` in
`/proc/pressure/memory`) is 10 or more. While it is, its host starts no agent, no **Check
pass** and no `collie verify` command. Each waits, says so on its card and in its Run's
log, and starts once the Machine is no longer short. Nothing running is stopped, and a
Run's start, a steer, a stop, the chats and **Cleanup** never wait. It binds a human's
start as it does an agent's, and no count of Runs, agents or checks is capped
(ADR-draft-new-work-waits-while-its-machine-is-short-of-memory).

**Installation** — What a Machine runs Collie from, which `identity` calls `root`. A
**release** is placed in the Collie directory's `release/` by the runner that carries it,
and an upgrade replaces it whole without git. A **development checkout** is a clone of
Collie that a developer linked as the plugin, built from source. Only git upgrades it;
Desktop and peers never do. A clone at the Collie directory itself is an install from before
ADR-draft-an-installation-is-the-release-its-runner-carries, and its next upgrade migrates it to a release.

**Collie directory** — `~/.collie`, or `COLLIE_DIR`: Collie's folder on a computer. Its
`release/` is the **Installation**. Its `user/` is the human's: the user **Layer**,
`config.json` and settings. No upgrade writes `user/`. Its `kept/` holds edits found in a
release before an upgrade replaced it (ADR-draft-an-installation-is-the-release-its-runner-carries).

**Flock** — Every Herd on every Machine paired with this one, or reached by **Desktop**.

**Peer** — A Machine paired with this one, known by its installation id and named by
herdr's label for it. A peer this one can open a connection to listens and is dialled; one
it cannot, such as a laptop, keeps a link open to it and is reached back over that link.
Each host keeps a relay socket for each peer, `peers/<name>.sock`, that speaks what
`host.sock` speaks ([ADR-0057](docs/adr/0057-a-machine-reaches-another-over-a-paired-link.md)).
A link's **transport** is `direct`, to the peer's port, or `ssh`, through the Machine's
**SSH connection** where the network refuses the port. Either way it carries the same
pinned TLS and secret, so SSH only carries the bytes. Each connect tries direct first, and
no setting chooses (ADR-draft-a-blocked-link-rides-the-machines-ssh-connection).

**Pairing** — The record each side of two **Peers** keeps in `peers.json`: who the other
is, which side dials, and the secret and certificate the link is authenticated with. Made
by itself the first time Collie reaches a herdr machine it has none for, over that
machine's SSH login, and removed when herdr no longer lists the Machine. There is no
command to pair or to forget.

**SSH connection** — The one SSH login a computer keeps open to a Machine. Its control
path is named by this computer's host, and ssh keeps it open after whatever opened it
exits. The link's `ssh` transport, Desktop's SSH route, Go to pane and pairing all ride
it, so a connection that is lost costs one approval. Only a front door that can show a
login opens one: Desktop, or a `collie` command that reaches the Machine. A host only uses
an open one, through ssh's control commands, and never logs in
(ADR-draft-a-blocked-link-rides-the-machines-ssh-connection).

**Local** — The Machine Desktop runs on, reached through a bridge it starts without SSH and
named by its hostname. Otherwise no different from any other Machine.

**Desktop** — The Collie desktop app: one more front door over each Machine's board, which it
reaches through `collie bridge` started as `desktop`. Not "native", which already means
harness-native (**Native chat**) and Effect-native.

**In sync** — A Machine that has everything **Desktop** gives its Flock: it is live, it runs
Desktop's Collie version or a newer release, it holds the latest edit of every shared
setting and every shared definition, it was given the credentials Desktop holds now but those its onboarding skipped, and `collie doctor` finds it onboarded. A Machine on a
development checkout, which nothing upgrades, is never behind on its version. Each part is
read from what the Machine's host and doctor last told Desktop, and from what Desktop last
gave it. A Machine that is not in sync is **behind** on each part it lacks, and each has its
own fix. Paired hosts keep settings, shared definitions and release versions level without Desktop.
Desktop also brings a Machine level as it connects and gives it credentials, so one that
stays behind is one where that failed. Not "up to date",
which is Desktop's own check for a newer release of itself.

**Machine rule** — The human's own words, kept in Desktop's settings, about which Machine
work goes to: "frontend work is on the laptop, everything else is on the vm". The **Flock
chat** is given it with every message, beside the Machines Desktop reaches at that moment and
which of them is this computer, and names the Machine a start goes to from it. Collie never
interprets the words itself, and a start that names no Machine while several are reachable
is still refused. Only the Flock chat chooses between Machines, so the rule is Desktop's
and no Machine is given it. Where the Run lands on the chosen Machine is still decided by
placement ([ADR-0033](docs/adr/0033-a-run-started-from-the-home-is-placed-not-asked.md)).

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
ones can be reopened, never two at once), a session of the harness Desktop's Settings name
for it — the user's own Claude Code (the default), Pi or Codex — driven from Desktop's main
process, on the model Settings name or else the harness's own default. A conversation is
held on one harness: a new model keeps it, a new harness starts a fresh one. It reaches
Collie through **Collie tools**, this computer through that harness's own file and shell
tools, and each Machine's files through `collie_read`, `collie_glob`, `collie_grep`,
`collie_write` and `collie_edit`; none of them asks first. Its Collie and file tools are
answered by each Machine's host over that Machine's `chat` channel, and name everything
`<machine>:<id>`, a file `<machine>:<path>`. Beside each Home's Native chat, never instead
of it.

**Chat harness** — Which native chat Collie opens with, `claude` (the default, on an
existing installation as much as a new one) or `pi`, from `chat_harness` in `config.json`.
It is a launch preference: changing it never stops, replaces or summarises a running
conversation, and never touches the harnesses Runs use. Each harness keeps its own native
history; nothing is carried between them. The **Flock chat**'s harness is Desktop's own
setting, apart from this one.

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
`collie_receipts`, `collie_definitions`, `collie_installation`, `collie_report`, `collie_news` — Herd-wide,
and never narrowed by the board's Filter or its Selection, which are what a human is
looking at rather than what supervision may see; the Selection is told to chat with each
prompt and stands in only where a tool was given no Run.
Three write — `collie_hold`, `collie_do`, `collie_propose` — and every one carries out
what the human asked for, at once, over the same closed action set, the same admission
check and the same executors the CLI and the board use. What Collie wants of its own
accord is a Proposal because of where it came from, never because of who confirms it. Reached over a local MCP server by Claude and a generated
extension by Pi, and by `collie tools call` from a terminal. Desktop's Flock chat takes
the same Toolkit's tools that a host's front door can answer, in-process, each answered by
the host of the Machine it names (`desktop/src/bun/flock-tools.ts`); `collie_run`,
`collie_receipts` and `collie_workspaces` with that Machine's Native chat's own reading.
Native chat's `collie_installation` reads its Machine's Schedules through their shared list shape;
the Flock chat's own `collie_schedules` names each `<machine>:<name>`. Schedule changes are `collie_propose` actions
over the same host operation the CLI uses.
It also has five file tools of its own that are not the Toolkit's, so Native chat's reach
is unchanged.

**Redirect notice** — What a per-workspace Collie pane from an older release shows on its
next launch: one line and "Open Collie". No board, no chat.

**Steer** — One free-form request about a named Run. Requested actions execute directly;
questions receive explanations without changes, and a dry run previews actions. A target
is required. Questions about a Herd are Native chat's, and about the whole Flock, Desktop's Flock chat's.

**Review comment** — A human's words about a quoted span of a Run's plan, or a line
range of one file in its diff, written where Desktop's record shows it. A draft held by
Desktop until it is sent, never a Collie record. Sent together, a Run's comments are one
**Delivery**, word for word, to one of that Run's live agents: not a Steer, because no
model reads them first, and not a merge request note (ADR-0051). Not a finding, which is
an agent's.

**Proposal** — A durable, hash-bound set of actions. Explicit requests execute through
this record immediately. Unsolicited background suggestions remain pending.

**Actor** — Who asked for an operation: the front door its channel declared (`board`,
`desktop`, `cli-tty`, `cli`, `chat`, `agent`, …) and the request id. The host records it in the Run's audit
trail with every start, answer, hold, stop, resume, offer invoked, grant, steer,
disposition and follow-up. `board`, `desktop` and
`cli-tty` are a human; `cli-tty` needs a terminal outside any agent's pane. A channel
reached through `collie bridge` is the front door it was started as, and `desktop` adds
where it came from: the computer it named and the SSH client the bridge saw. Every front
door's Actor names `from.machine` where the channel came from a **Peer**, stamped by the
host that authenticated the link and never by a caller, and a host's own call to a peer is
the `host` front door, which is never a human. An `agent` is never a human either;
its `from.run` and `from.agent` name the launch or the registered pane. A chat's
`collie_do` also names its conversation and carries the human's message from that turn,
with the names of the **Attachments** it carried, attached by the tool host and never by
the model. A Run a **Schedule** starts is the host's own doing, recorded as `schedule` with
the Schedule's name and the occurrence it was for; it is not a human.

**Confirmation** — A command naming a Proposal's id **and** its content hash. A yes to a
summary is not consent to a payload nobody read. Anyone may give one — a human at a
terminal or on the board, or chat through `collie_do` — and who did is recorded: a human
is derived by the front door, never claimed by a caller; native chat's bridge is `chat`,
stamped by the entrypoint that serves Collie tools, because it runs inside a harness's pane
and the CLI would otherwise read its terminal as a person. Attribution is audit, never a
gate. No action kind confirms anything, so a Proposal can never contain its own.

**Delivery** — One message to one live agent incarnation, with states `queued` (a boundary
delivery an older Collie held for the agent's next prompt), `reserved`, `deferred` (herdr answered that the
pane cannot take it yet, so it is tried again under the same id), `submitted` (sent),
`acknowledged` (the agent took a turn after it) and the terminal `failed` and `superseded`;
`unknown` blocks the same work until a human settles it. They are separate because they are
separate facts, and whether the work then went where it was told is the drift judgement's.
A `deliver` with no mode is `now`. One that names no agent reaches **the agent at work**:
the agent whose step is active, else the Run's builder (its implementer); `to` names a role
— `builder`, `reviewer`, `planner` — or an agent instead.
A Delivery from an agent carries its sender line before the unchanged words: its agent,
Run and Machine, and the tool and CLI address to answer. One carrying a human's words says
so on that line: the human, the door and the time; chat's names the human's own message
from that turn. Collie's own step messages and repairs carry none. A Delivery whose typed
form would pass three lines or 700 characters keeps its words as a file in the Run and
types only a short sender line and where the file is, because Claude Code shows longer typed
text to its model as pasted content (ADR-draft-what-a-run-authorises-reaches-auto-mode).

**Clearance** — What one step's agent is told, in its own turn, that it may do. Each entry
is a sentence naming one action and its target (push this branch, merge this merge request,
play this stage job), composed by the Workflow from facts Collie holds and never from an
Output. Collie types it after the step's pointer, so a harness reviewing the agent's calls
reads it as the user's request for exactly that. Not a permission rule, which would skip
that review. Not **Authority**, which is what Collie may do to a Run.

**Dispatcher** — The only code that sends text to an agent. Holds that agent's ledger lock
across the compaction decision, the composition and the send.

**Incarnation** — An agent as one live process, identified by herdr's own `terminal_id` and
`agent_session`. A name and a pane are inherited by whatever takes the role next; neither
names a process. A registry entry without one is never a delivery target. Where a Harness's
work runs outside its pane — Codex's, in the App Server Collie starts for that one agent —
the incarnation is the pane's process and that server, with every thread loaded on it,
until the server is **Quiet**.

**Drift** — A recorded evidence–Intent mismatch. `rule` drift Collie establishes itself;
`semantic` drift is judged against bounded actual evidence. Nothing passes on an absence.

**Correction** — A Delivery caused by Drift, counted against Authority. `correction_submitted`
on send, never `corrected`: sending text is not the work changing.

**Manual override** — An incarnation that received input Collie did not send. Automatic
corrections to it stop until an explicit `run clear-override`; nothing times it back on.

**Forge** — The service that hosts a repository and its **Merge requests**: GitLab or GitHub. A checkout's forge comes from the host of its `origin` remote, or of `upstream` where `origin` names none. `github.com` is GitHub. The Flock's `gitlab_host`, or any host whose name contains `gitlab`, is GitLab. Any other host has no forge, and a step that needs one says so. Collie reaches a forge only through that forge's adapter: `glab` for GitLab, `gh` for GitHub. The adapter also writes the commands an agent is told to run, so no prompt names a CLI of its own ([ADR-0050](docs/adr/0050-a-merge-request-is-its-forges.md)).

**Merge request** — A proposed change to a repository's default branch, on its **Forge**. Collie's word covers a GitHub pull request too. A human is shown the forge's own word and name: merge request `group/app!42` on GitLab, pull request `owner/repo#30` on GitHub. A Run reviews one as the target `mr:<host>/<group>/<project>!<iid>` or `mr:github.com/<owner>/<repo>#<number>`. Collie reads for itself whether a merge request merged, closed, deployed or merges itself once green; none of these is taken from an agent's Output.

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

**Hold** — A Run under a hold starts no new work until a human releases it. It takes effect at the Run's next boundary, so what is already running finishes. Nothing lifts a hold at a time. A hold never touches a running turn; **Stop** does.

**Stop** — Ending a Run's work now, and its children's. Each live agent is stopped where
its work runs, and only then is its pane closed. An agent that does not become **Quiet** is
named in what the stop reports, its pane is left open, and nothing takes its work until it
is (ADR-0059).

**Quiet** — An incarnation that can no longer change anything. Every turn it was running
has ended, as read back from the harness. The process that ran them is gone, and nothing it
started is still running. `submitted` (an interrupt was sent) and `acknowledged` (the
harness accepted it) are not Quiet. Only Quiet counts as stopped.

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

**Constraint** — One thing a Run's work must respect. `kind: rule` is checked by Collie itself; `kind: semantic` is judged. `severity: block | warn`. Its `source` says where it came from — `human`, `workspace-default`, `parent` or `plan` — and a `plan` entry carries the file, heading and line it was read from. A `plan` constraint narrows the goal it was cut from: the goal is what was asked, never evidence of drift against it, and a judgement reads the work (ADR-0036, amended 2026-10-19). Text is evidence: no Constraint, wherever it came from, grants Authority.

**Authority** — What Collie may do to a Run without a new request: correct drift, send at a work boundary or interrupt, stop the Run, and how many corrections a constraint gets. Per Run, correcting drift at a work boundary is on by default; every other grant is off and is set by an explicit command or request. No grant is ever inferred from repository content or worker output. Model-call usage is recorded per Run and per Herd but is not an Authority: it is data, and never a quota that blocks work.

**Run** — One execution of a Workflow: its Inputs, its operations' Outputs and its status, kept as an audit trail. The host holds it. A restart or a resume re-enters the Workflow's current code and reuses every Activity already done, so finished work is not done again and a pending question is still pending; a Run whose code has since changed shape has no such promise, and one whose module is missing waits, naming the file. Nothing the previous engine recorded is carried over (ADR-0027). Its **slug** — `<workflow>-<what it is named after>` — names its agents, its tab and its row on the board, and for a mutating Run it is named after the task half of the Worktree's branch — the branch without the login it is namespaced under — so two Runs on different work can never read as the same row.

**Task** — One piece of work a human is doing, and the Runs it takes: a plan, the
implementation it chains into, the review of that, the release of its merge request.
Recorded on every Run at creation and inherited by chains, follow-ups and resumes, so
membership is a fact rather than a reading of a label — two Tasks may share a project
prefix, and a workspace renamed by hand is still its Task's. A Task's **work** is what its
Runs worked on: each branch one was placed on, other than the default branch, and each
merge request one opened or was given — read from their records, never from the checkout
the Task was rooted at. A Run started fresh is a new Task, unless it is about that work —
the merge request its diff target names is one of a Task's, whatever state that Task is
in, or the branch it is placed on or its diff target names is one of an open Task's, one
whose workspace herdr has — and then it is the Task's that had it first: one workspace per
Task. Joining is membership, not **Lineage**: a Run that joins has no parent. Anything
else joins a Task only by an explicit **Continue task**. A child Run is its parent's
Task's, unless it was started as work of its own (`ownTask`): then it is placed as a fresh
start is, and is still its parent's child (ADR-draft-a-tasks-work-is-what-its-runs-worked-on).

**Task workspace** — The herdr workspace a Task's Runs, tabs and agents live in. One per
Task, made when its first Run is admitted, on the checkout that Run is given. It is never
focused: a start does not take the human away from what they are doing. Collie closes it
an hour after its Task is **Finished**, unless herdr has it in focus at that moment or it
holds a pane Collie did not open, which keeps it open until the human closes it (see
**Cleanup**). Its label is inferred once, at creation — `<Project or theme> | <what
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
it in **Needs you**: a **question** a Run asked, or a **Proposal** Collie made. A question
is the Workflow's, asked with `ask`, or one a Run's agent asked with its harness's own
question tool, which Collie puts on the Run and whose answer it delivers to that agent. Any of a
Task's Runs can be waiting on one, a fan-out's Repo runs included, and each is answered on
the Run that asked. Both are answered on the card, from the CLI or from chat, and survive
the board closing. A Run's **Checks** are never one: nobody approves them (ADR-0055).

**Stalled** — The other way into **Needs you**, and the one with nothing on the card to
answer: an agent is waiting for a human in its own pane — at a dialog of its harness's
that Collie could not put on the Run, which herdr reports as a `blocked` agent — or a Run parked because its agent's pane would
not take a prompt. Either way the work has stopped, so the card says which pane to go to
rather than what the step was doing.

**Wait** — What holds a Run up at a moment: a **Decision** on it, **Stalled**, a **Hold**,
**Short of memory**, or something it awaits that ends by itself. A Check Collie runs for it
is shown the same way. A Run can have several at once, and each front door says the one it
ranks first.

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

**Ready to release** — A Waiting on you Task whose merge request the forge would merge now:
its leading Run succeeded; the merge request is open and not a draft; every check approved
for the Run passed at its head; the forge's pipeline at that head passed, or there is none;
no blocking review finding is unresolved; and the forge says it can merge. It is one fact,
computed once in the board model, that the board, `collie run show`, `collie run wait
--until ready` and chat all read, with each missing fact named and marked as one that may
still come by itself (CI running, the forge still working it out) or one only a human can
move. A card leaves Ready to release when CI or mergeability later says no. An open merge
request that is not ready is still Waiting on you, and its card says what is missing.

**Reopened** — A finished Run one of whose agents was sent a steer Delivery after the Run
finished. Not a status: the Run still reads `succeeded`, `failed` or `stopped`, because
that is how its steps ended. Derived from the delivery ledger and herdr's agent state, so
nothing records it. Its card is in Working while that agent works and in Needs you while
it is blocked, then stands on its own facts again. Steering reaches a finished Run's
agents for as long as one is alive; a gone pane is the Follow-up Run's job (ADR-0041).
A finished Run's agent is closed once it has been idle for an hour since the Run finished
(**Cleanup**), so a Run can be Reopened only until then.

**Landed** — What a Task's work has done once it needs nothing more from anyone: a
**Disposition** was recorded — merged, abandoned or superseded — the Run succeeded at a
Workflow that produces nothing to land, such as a review, or it ended with nothing anyone
could file: no branch, no merge request, no plan, no question. A Task whose work has landed
is **Finished**, the board's last section, as long as none of its Runs is still going,
asking or stalled and none of its agents is working. Finished is what **Cleanup** waits
for before it closes anything of a Task.

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
to it, and new work is generated as `<login>/<task>` — the login of the checkout's **Forge** — rather than asked for, so two
Runs on different work can never key the same checkout
([the order it is resolved in](docs/cli.md#start-a-run)). Only the Run's cwd moves; its tabs stay in
its Task's workspace and are `cd`-ed into the checkout, because a Run belongs where its
Task is (ADR-0006). A Workflow declares one — `checkout` in its metadata — and the host
cuts it at admission, before the Run exists, from the checkout the Run starts from: a
directory that is not a git checkout is refused, named. `implement` and `renovate` declare
one; `plan`, `architecture`, `review` and `general` declare none, and the `implement` they chain into
is placed by its own declaration, in the same Task. A `review` Run that fixes its own
findings is given the reviewed branch's checkout when the fix starts, and from then on that
checkout is the Run's: what it verifies is that tree
([ADR-0054](docs/adr/0054-a-reviews-fix-works-in-the-reviewed-branchs-checkout.md)). A
Renovate Run's is the one that holds no branch — see Renovate Run.

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

**Settled** — A Collie-created Worktree that holds nothing which exists only there:

- The tree is clean.
- It holds no commit that is not on the remote already.
- Nothing is working in it, and no Run whose work has not landed could be resumed in it.
- Its work has landed: the merge watch read its merge request as merged or closed, on
  GitHub or GitLab; a **Disposition** was recorded; or its remote branch is gone.
- Its Task's workspace has closed.

A commit is on the remote when a remote-tracking ref contains it, or when it is the head
its merged merge request was merged at. A squash merge leaves the branch's commits on no
branch, and "on the default branch" would keep that checkout for ever. A checkout Collie
made whose branch was switched since is still Collie's, by its path and the moment git
wrote it, and is judged on what it holds now. The plugin root, a repository's main checkout
and any checkout a running host serves from are never removed ([ADR-0045](docs/adr/0045-collie-removes-what-it-made-once-nothing-needs-it.md)).
Only then is it removed, through herdr, and only ever without a force flag:
git's own refusal to drop a dirty or unmerged checkout is the last guard, so a wrong
judgement can fail to clean but never delete work. Removal is never forced whichever
manager does it. The conditions and their order are canonical in `src/worktree.ts` and
`docs/internals.md`.

**Cleanup** — What Collie removes once nothing needs it, and only what it made and can
show it made. Its own directories (the state directory, `~/.cache/collie` and Desktop's)
are its own by where they are, and only kinds it knows are removed from them. A Worktree,
a Task workspace, a pane and a process are proved by Collie's own record of making them.
The host sweeps every ten minutes. `collie cleanup` lists what a sweep would remove now,
how much space that frees, and what Collie keeps and why. `collie cleanup --apply` sweeps
now. In order:

1. A **Finished** Task's workspace closes after an hour.
2. Its Worktrees go once **Settled**.
3. Thirty days after its last Run ended, the Task and every one of its Runs are forgotten
   together: rows first, then files.

What each kind keeps and why is canonical in
[ADR-0045](docs/adr/0045-collie-removes-what-it-made-once-nothing-needs-it.md). Every
removal is recorded with who asked, and none is forced. A check's processes are proved by
their record or by the marker they run with. Any that no host is collecting are ended,
SIGKILL included, because a check's result is thrown away
(ADR-draft-a-check-ends-with-the-host-that-runs-it).

Apart from that order, an agent Collie launched for a Run that has finished is closed once
herdr has reported it idle for `idle_close_ms` (an hour by default; 0 never), counted
from the Run's finish if it went idle before then. It is kept while a Delivery to it is
queued, a question it asked is open, its pane is focused or a human has typed into it
since it went idle. A pane herdr restored after a restart is the agent whose recorded
harness session it resumes. A closed agent stays closed: a steer to it is refused, and the
Run's Follow-up is offered. A live Run's agents are not closed idle
(ADR-draft-a-finished-runs-idle-agent-is-closed).

**Renovate Run** — One execution of the `renovate` Workflow: one repository, from claiming
it in Helle to checking it off in Linear. Its Worktree is detached and roams — it holds no
branch of its own and moves across the Renovate Bot branches it merges, pushing each with
an explicit refspec — so the operator's own checkout is never touched. A Renovate branch
another registered Worktree holds is reported and left alone, never taken and never reached
around with a detached remote-tracking ref.
The one branch it does bind, for an application, is the batch branch the Renovate Bot
branches are merged into: `deps/batch-<YYYY-MM-DD>`, or `collie/batch-<YYYY-MM-DD>` where
the repository's `branchPrefix` covers `deps/`. It is Collie's, so it is never named under
Renovate Bot's `branchPrefix` (`renovate/` by default): the Bot owns every branch there and
marks a request from one it did not make as abandoned.

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

**Release Run** — One execution of the `release` Workflow: one merge request taken from
open to landed. It answers **External review comments** until the forge says the merge
request is approved, then asks for a **Go**. On it, it claims in Helle every project it
deploys under, and merges nothing without them unless the human says so.
An application is either staged from its merge request for testing, then merged and
tagged, or merged, tagged and staged from its tag. Either way it goes to production on a
second Go. A package is merged and tagged. Collie merges, and reads from the forge every fact it
decides on. The Run's agent fixes, stages, tags and plays the jobs. It works in the
checkout of the merge request's source branch and is held to the **Checks** of the Run it
was started from. It starts as a child from an implement Run's end menu, from a succeeded
implement Run's `Release` offer — on the card, from the CLI or from chat — or on its own, and then it is still the **Task**'s whose
merge request it is (ADR-draft-a-merge-request-is-released-on-a-humans-go,
ADR-draft-a-tasks-work-is-what-its-runs-worked-on).

**External review comment** — A comment on a merge request by anyone but the forge login
Collie acts as, and not a bot's or the forge's own note. A reply in a thread is one of its
own. A **Release Run** answers each one once: fixed, naming the commit, or disputed, saying
why. It never resolves a thread, because that is the reviewer's call.

**Go** — The answer that lets a Run do what cannot be taken back: start a release (claim,
stage, merge, tag), and send one to production. It is asked on the Run once the work is
ready, never at its start. The first holds for one head: a head that moves takes it back.
The second holds for what it sends. Before a merge, that is the head on stage, so the same
rule applies. After one, it is one tag and the production jobs that tag names. Who answered
is recorded, never a reason to refuse.

**Layer** — Where a definition is looked up, later wins by name. A Workflow is one `*.workflow.ts` entry, found project `.collie/workflows/` first, then the user's `~/.collie/user/workflows/`, then the installation's `workflows/`; a broken override is reported, never fallen through. A Persona is Markdown, found the same way: the project's `.collie/personas/`, then the user's `~/.collie/user/personas/`, then the installation's `personas/`. Forking takes a baseline definition into a later Layer. The user Layer's files are **shared definitions**: every Machine in a Flock holds the latest edit of each, its removal included, so the user Layer is the Flock's rather than one Machine's ([ADR-0061](docs/adr/0061-a-users-definitions-are-the-flocks.md)).

**Override** — A Persona that declares `extends: <name>` and changes only what it names; everything else still follows the parent in the Layer below. A file without `extends:` replaces the whole Persona, and a full copy records `forked_from_hash` so a parent that has moved on can be marked stale. The merge rules are canonical in `src/definitions.ts` and `docs/authoring.md`. A Workflow is overridden by an entry with the same id, and customised by importing what it keeps.

**Fan-in** — Combining several parallel Outputs into one: an operation handed the other operations' Output files, which reconciles them itself. Nothing unions findings for it.

**Synthesis** — What the fan-in over reviewers writes, or a lone reviewer writes itself: one review of the change, deduplicated across models, disagreements settled from the diff, plus a `summary` and the findings it `dropped` with a reason for each. It is rendered to `review.md`, which is what a human reads and what a review may post. It is the loop's gate: the fix sees the Synthesis, never the raw reviews.

**Disputed** — A finding the implementer declined, with its reason. The reviewers are shown the reason, and a disputed finding no longer drives the loop, so the Run converges and the human decides. A reviewer who can answer the reason raises it again with a `rebuttal`, which puts the finding back in front of the implementer.

## Baseline Workflows

What each is for, what it needs, and how they chain: `docs/workflows.md`.

- `plan` — interviews the human, then writes `SPEC.md` and one ticket per slice into its Run's plan directory (ADR-0002).
- `implement` — builds from a work source, reviews what it built with the same pass `review` runs, loops on the findings, and opens or updates the merge request last, only where the evidence is there. Then it asks what next, unless started with `then=finish` or `then=release`: `Release` takes its merge request the rest of the way as a child **Release Run**. No architecture or simplification pass: those are work the change asks for, not work every Run does.
- `release` — answers a merge request's External review comments until it is approved, then, on a Go, merges and tags it. An application is staged either from its merge request, for testing before the merge, or from its tag after it, and goes to production on a second Go.
- `review` — standalone; you pick the target; one complete review, and a synthesis that reconciles the reviewers where more than one axis is asked for.
- `architecture` — runs the architect over the project and reports into its Run's plan directory.
- `renovate` — claims the repository in Helle, merges or accounts for every Renovate Bot merge request, tags and watches the release, and records the result on the team's Renovate issue.
- `general` — one agent does one ad-hoc task in place, in the checkout it was started for or at the Projects root, and the Run ends with the agent's summary. It is for whatever is not planning, building to a merge request, reviewing, renovating or surveying architecture. Work that should land as a merge request is `implement`'s (ADR-0056).

- `investigate` — one investigator reproduces a goal on its Machine, returns findings and closes after its host reports to the requester.

**Requester** — The agent Actor that started a Run, recorded as `requestedBy`: its Run, agent and Machine. Once the started Run settles, its host reports its status, summary or failure and where its full Output is to that address. The report records delivery or why it could not be delivered, without queuing later delivery. A Workflow declaring `closes: "reported"` then closes its own agents and its Task workspace when nothing else needs it.

**Outcome** — The kind of result a Run has to prove, and the evidence that closes it: a feature names what it built, a bug reproduces before it is fixed, a refactor preserves behaviour, an investigation reaches a supported conclusion and may have no patch, docs run what they document, a migration proves it can go back. A Run nobody classified is `unspecified` and proves only its **Checks** — never a feature by default.

**Checks** — The commands Collie runs itself to prove one Run. Each is an executable and its arguments, bound argument for argument and run in a tree the Run owns, and nobody approves them. They are the ones given with the start (`run start --verify`, or chat's `start` with `verify`), else `.collie/verify.json` in the project, else the checks remembered for the checkout's remote (`~/.collie/user/verify/<host>/<path>.json`, written by `run intent remember` or chat's `remember_verification`), else `~/.collie/user/verify.json`. The first found is taken whole and kept with the Run: in its Intent's `run_verification`, or in the host's record for a workflow module's Run. Where none of those has any, the Run's own agent names them from what the repository says proves its work, before it builds, and Collie records and runs them without asking. Anyone (a human, chat, or the Run's agent) adds or withdraws a check on a live Run with `run intent verification` (chat's `set_verification`). The gate reads them at every pass. Nobody is asked to approve one, and no start is refused for want of one. A Run whose agent still names none after its gate fixes is held unproved, as a failing check is (ADR-0055). An agent may `collie verify` anything but the Run's own Checks, which only the gate runs: given one, `collie verify` answers with its latest record on the tree, or refuses and names the gate, for a human as for an agent (ADR-draft-a-runs-checks-are-run-by-its-gate). A check may be **left to CI**: its entry names, as `ci`, the merge request pipeline job that proves it. Nobody runs it locally, the gate skips it, and once the merge request is open the Run waits for that job on the merge request's head commit; a failed job is a fix round like a failed check (ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job). Formerly the "approved set"; code still calls them `approved`.

**Evidence** — A Verification collected at a revision: a command Collie ran, or a pipeline job Collie read from the forge on that commit for a check left to CI. An Output field saying the tests pass is a claim, and is shown as one. The gate before a merge request reads evidence, never claims.

**Tautology** — Work that cannot be wrong, so it shows nothing. It is a test that restates the code, asserts that a mock returns what it was told, or cannot fail. It is a verification of something no change could break, such as a text search for code the change just wrote. It is a comment or doc that says what the code already says, or a criterion true by construction, such as one the base already meets. It is a finding, summary or hand-off that only repeats the goal or the diff. It is a judgement nothing can be reported against, or one that cites its own goal as evidence. Every agent Collie launches is told not to make one and to raise one it finds as a finding. A gate never counts one as proof. A new test shows something only once it has been seen failing. The builder records it failing before the code that makes it pass, and the reviewer raises one never seen failing (ADR-draft-a-tautology-proves-nothing).

**Baseline** — The tests of a check that still fail at the gate, after their **Flake** rerun, run once by Collie where the Run's branch leaves the default branch, in the Run's own checkout. When every one of them fails there too, the check is not handed to the implementer: the merge request names those tests as failing before the Run's changes, with the revision. A test the base does not report failing, one that does not exist there included, is the Run's own. A check whose failures name no tests has no baseline, because its exit code cannot establish that the Run added no failures: it stays required on the Run's current tree and goes to the gate fixes (ADR-0034, amended 2026-10-15).

**Integration** — The default branch merged into a Run's branch where it has moved since, with a merge commit in the Run's own checkout: never a rebase and never a force push. It never touches uncommitted work, never counts a default branch it could not fetch, leaves a conflict for the builder to finish, and is recorded in the Run log as `integrated <branch>@<sha>`. A review is diffed against the merge-base it leaves. Until its merge commit is made, drift reads only the Run's side of it: the default branch's incoming changes are never the Run's evidence, and a work boundary reached with its conflicts open is not judged.

**Acceptance criterion** — One checkbox under a ticket's Acceptance criteria heading: something the implement Run can show before its merge request. The builder's Output answers each with how it is met (a test, a file), `not met: <reason>`, or `after merge: <reason>` where only CI, a merge or a deploy can show it. One unanswered or not met goes back to the builder before any reviewer sees the work, and the criteria are read again before each hand-back, so an amended ticket is judged as it reads now. The reviewer is shown every answer, and raises as blocking an `after merge` the Run could have shown. An outcome the planner already knows only a merge or a deploy can show is listed under the ticket's `## After merge` heading instead, and is not a criterion. Both reach the merge request under **Not settled by the run** (ADR-draft-a-criterion-is-what-the-run-can-show-before-its-merge-request).

**Check pass** — One run of one of a Run's **Checks** by Collie, or the pass on this tree it
relies on instead, with why it runs: `gate` on the
Run's branch, `rerun` of only the tests that just failed, on the same tree, to tell a
**Flake**, `baseline` where the branch left the default branch, `recheck` of a whole check
whose failures name no tests, on the same tree, `fix` after gate fix N, `finish` at the
Run's end, `ci` for a check left to CI, read from the merge request's pipeline, or a plain
`check`. Past that one `recheck`, a check is not run whole again on a tree it already
failed on: after a gate fix that left the tree as it was, the records on that tree stand.
A resume of a Run held unproved is the exception, because a repair can be outside the tree:
each check still failing there runs whole once more (ADR-0034, amended 2026-10-19). The pass is the Workflow's declaration, never read off its
id. While it runs, the card and chat say the check, the pass, how long it has run against
how long it usually takes, and where its output is being written (ADR-0042).

**Flake** — A test of one of a Run's **Checks** that failed, then passed when Collie ran it
again alone on the same tree. Collie reads which tests failed from the check's own output,
for a runner whose output it knows (bun test first), and reruns only those, once. A flake is
not a gap the gate fixes are handed, and never a pass: the merge request names it under
**Not settled by the run**. A check whose failures name no tests has no flakes, only its
whole `recheck` (ADR-0034, amended 2026-10-15).

**Obstacle** — What is identifiably in a Run's way, in one sentence: a command failing several times in a row the same way. It is shown to the human and given to the next prompt so the approach can change. It stops nothing.

**Slice** — One item of a list of work — a ticket's build — known by its name, never by where it sits. It has its own prompt and its own Output, runs on the list's one agent, and is handed only its ticket and a few lines of fact about the items before it — their commits and what they verified, never their transcripts. A replayed or resumed Run reuses the items already done and does only what is left.

**Choice** — A question a Run asks the human with `ask`, from a closed set of options: what the answer does next — start another Workflow, prompt an agent, post a review, stop — is the Workflow's own code. An answer outside the options, or a second answer to one already answered, is refused and starts nothing.

**Chain** — Starting another Workflow from a Run, with `child`: typed input decoded against the child's schema before it is admitted, a stable invocation name, and the child recorded as this Run's. Replaying the parent reuses the child it already has. A child started as work of its own is a Task of its own, and still this Run's. A fan-out chains several at once, one per repository a plan touches; see Repo run.

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
one field it hints with `goal`, `work-source`, `diff-target` or `repository` — where
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
board belongs to the card it is on. In **Desktop** it is the card last clicked, whether or
not its record is open, and it is what the Flock chat's chip is about: opening a card's
record selects that card, and a click on the board's background, Escape outside a field or a
message sent clears it. A message sent with a Selection keeps it: the message shows that
card's name as a pill for as long as the conversation is kept, and the pill opens its record.

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
fix round's next iteration. Collie waits there until herdr reports the agent idle, and
only then reads that harness's current-context measure and, at or above the user-wide
`compact_at_tokens`, asks it to compact natively before sending anything. Not a liveness
nudge, not a mid-step recovery message, and not a human typing in the pane — none of those
are work. A freshly launched agent has no boundary before its first piece of work. What
Collie does with each outcome, and what it shows while a compaction is unresolved past five
minutes (it keeps waiting and sends the work once the compaction ends):
`docs/using.md`.

**Notification** — The only channel from an unattended Run to the person who started it, so what is not worth interrupting for is not sent at all. One title shape — `<repo> · <slug> <what happened>` — one taxonomy in `src/notify.ts`, once per `(run, kind, step)`, and never a reason for a Run to fail.

**Host** — The one background process that runs work for a state directory. CLI, board and chat all reach it over the same local RPC, and closing any of them leaves its work running. It owns the directory under `host.lock`, keeps its Runs in SQLite until **Cleanup** forgets them, and on restart hands every accepted Run back to the engine, so completed work is reused rather than repeated. A check it runs ends with it. Whatever stops a host ends its checks' processes first. A host that starts ends any check a previous host left running before it hands Runs back, so the check runs once more and never twice at once (ADR-draft-a-check-ends-with-the-host-that-runs-it). A client of another build is told to restart it before `HostRpcs` (ADR-0015); `FrontDoorRpcs` serves any build (ADR-0038).

**Schedule** — A start saved with when to make it: a name, a cron expression read in a
time zone, and the start as an agent's start gives one — the Workflow, every Input, the
checkout. A Machine's, kept by its **Host** and fired by no other: that host's engine
sleeps a durable workflow execution until each occurrence, one after another. Whoever adds it
chooses that Machine, every listing names it, and moving it to another Machine adds it
there paused, removes it here and resumes it there, with both Machines reachable. No other
Machine fires it in its place. Checked when it is added as such a start is. Missed occurrences — the Machine off, or its host not started — collapse into
one, started late. An occurrence that falls due while the Run the Schedule last started has
not settled waits for it, so a Schedule has one Run going at a time. Pausing stops it
without catching up. A Run it starts is any Run, placed as a fresh start, and its record
says which Schedule started it ([ADR-0052](docs/adr/0052-a-schedule-is-a-saved-start-its-host-fires.md)).

**Self-improve Run** — One execution of the shipped `self-improve` Workflow, in a project's checkout: one day of Runs, that project's (`runs=checkout`) or its whole Machine's (`runs=machine`, which alone files Collie's own `defect`s), read with the installed `retro` skill, what they show is wrong filed or commented on that checkout's forge, and up to `improvements` **Improvements** started and waited on ([ADR-0053](docs/adr/0053-collie-files-and-fixes-what-its-own-runs-show.md)).

**Improvement** — One merge request's worth of issues a **Self-improve Run** filed new: a `plan` child that is a Task of its own, started with `then=implement`, whose goal is those issues and whose merge request closes them. Nobody is asked anything until the merge.
Not a shared setting: its checkout is a path on one Machine.

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
