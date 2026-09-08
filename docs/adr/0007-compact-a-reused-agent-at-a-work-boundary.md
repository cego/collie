# Compact a reused agent at a work boundary

Collie asks a harness to compact its own context at one place: immediately before a
reused agent that has finished its previous work is given the next piece. One user-wide
absolute threshold decides — 372,000 current-context tokens, `0` to turn it off — and one
policy in `src/compaction.ts` owns the threshold, the fixed five-minute budget and what
counts as an outcome. The four harness adapters in `src/compactors.ts` supply only four
things each: a compatibility gate, the launch arguments that install the controls, the
harness's own current-context number, and what its own interface has established about
one request.

Absolute rather than a percentage of a window, because the four harnesses measure
different windows and one number is what a human can reason about. Native automatic
compaction stays enabled everywhere: this is an extra floor, not a replacement, and a
harness that compacts before Collie's threshold has already done the job.

## Why a policy and not four

Every work-dispatch path shares it — a Workflow's next step, a fix round's next
iteration, a hand-off from another Run — and a threshold repeated per harness is a
threshold that disagrees with itself. The distinctions the policy makes are the whole
value of the feature, and they are the part that must not be reimplemented four times:

- No usable sample — the harness has not measured this context, or the read failed —
  warns and sends the work. Never compact from a guess or a stale high reading.
- A confirmed failure warns and sends the work.
- A request that never left — herdr refused the prompt, no endpoint was recorded, the
  thread could not be bound — warns and sends the work. Only the adapter can know this,
  so `Unsubmitted` is part of the port's contract: everything before the submitting call
  carries it, and the submitting call's own failure does not, because a socket that
  closes and an HTTP call that times out may have been accepted first. A submission that
  broke is the unknown outcome, not a failure nobody observed.
- An acknowledgement that never resolves is neither. After five minutes the step stops
  blocked with the reason, and the attempt stays on the agent's record so nothing sends
  that agent work while it is still in the air. A timeout is not proof the agent stopped
  compacting, so nothing retries, touches the agent or replays the work.

One caller does not wait: the Control Plane runs its actions on a single fiber, one at a
time, so a hand-off pressed there asks for the compaction and comes straight back saying
it is in the air. Holding that queue for five minutes would freeze the board — stopping a
run, opening a log, changing a setting — with nothing on screen to explain it. No work is
sent either way, which is the part the spec fixes; the wait is the part it fixes only for
a Run's own boundaries.

A pause is the existing blocked-step path, not a new state: the board draws the waiting
glyph, the ending raises `needs-you` with the reason, and `collie run resume` picks the
Run up. The CLI's word for a blocked Run is `failed` — "ended unsuccessfully with
unfinished work" (see `operations.runStatus`) — and a pause is deliberately presented
that way rather than as a fifth Run status. It is not `awaiting`, which says a Run is
still going and would leave `run wait` watching a directory nothing will write again.

## Only newly launched agents

The controls are launch arguments, so an agent that was already running when the feature
arrived keeps working exactly as it did. There is no migration, retrofit or restart flow,
and an agent with no control record is given its work as Collie always gave it.

A harness Collie manages but cannot talk to refuses the launch instead of starting an
unmanaged agent and logging a warning. That silence is how a partial-harness feature
ships, so the gate fails the step before a tab opens — the same contract as an
unresolvable permissions mode.

## What each harness actually supports

Checked against the installed releases rather than upstream source, and three of those
checks changed the design. A version is the floor the gate enforces, not an equality:
the OpenCode checks last ran on 1.18.29.

| Harness     | Release | Endpoint and identity                                                                                   | Current context                                  | Request                                                 | Outcome                                                                       |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Pi          | 0.85.1  | An extension passed with `-e`, writing its session file path                                            | `ctx.getContextUsage()`                          | a bundled command calling `ctx.compact`                 | its per-request `onComplete`/`onError`                                        |
| Claude Code | 2.1.263 | A settings file passed with `--settings`; the payloads' `session_id`                                    | status line `context_window`                     | `/compact` with a correlation token in its instructions | a `PreCompact` carrying that token, then the next manual `PostCompact`        |
| Codex       | 0.153.4 | One App Server per agent on a loopback port; exactly one non-`ephemeral` thread in `thread/loaded/list` | `thread/tokenUsage/updated`'s `last.totalTokens` | `thread/compact/start`                                  | a `contextCompaction` item that was not there before, and its turn's status   |
| OpenCode    | 1.18.9+ | The TUI hosting its own loopback server, on a session Collie created and passed with `--session`        | the latest assistant message's tokens            | `POST /session/{id}/summarize`                          | a `mode: "compaction"` message that was not there before, and its error state |

Three deviations from the plan, each forced by the installed release:

- **Codex's transport.** `--listen unix://PATH` binds, but nothing sent over that socket
  is answered — not by a raw client and not by `app-server proxy`. `ws://127.0.0.1:PORT`
  is answered and is a documented `--remote` form.
- **Codex's subscription.** A second client is sent `thread/started` and
  `thread/status/changed` and nothing else; token usage, items and turns go only to the
  client that owns the thread, which is the TUI. `thread/resume` on a thread that has a
  rollout rejoins it and immediately replays the current token usage. That replay is the
  only way Collie can read a Codex agent's context, and it is why every read is a fresh
  short-lived connection rather than a second Collie process per agent.
- **Codex's ephemeral thread.** A TUI loads a cheap thread of its own — another model,
  no preview, `ephemeral: true` — beside the one it is working in, so an agent's own
  server answers `thread/loaded/list` with two. Identity reads each and ignores the
  ephemeral one; the refusal is kept for two threads that are really the agent's.
- **OpenCode's identity.** Its servers isolate nothing: every one answers `GET /session`
  with every session in the project, and `/session/status` and `/api/session/active` are
  empty unless a session is mid-turn. Two agents in one directory could not be told apart
  from the API, so Collie creates the session on a server that lives just long enough to
  make it and hands it over with `--session`. `serve` + `attach` would have let Collie own
  the server for the agent's whole life, but `attach` takes neither `--model` nor
  `--auto`, and a Collie-launched agent may not lose its model or its unattended switch.

Three harnesses give a compaction no request id of its own, and all three are correlated
the same way: record what the session already had before submitting, and only something
that was not there before can be this request's. Neither an automatic compaction nor a
human compacting in the pane can complete an attempt Collie is waiting on.

Claude looked like the exception, because `/compact`'s instructions do come back — but
they come back in `PreCompact` alone. The installed release builds its completion as
`{hook_event_name: "PostCompact", trigger, compact_summary}`, with no field the request
survives into, so the marked `PreCompact` is the start and the first `manual` completion
after it on the same session is that compaction's. A human's own `/compact` announces
itself with an unmarked `manual` `PreCompact` first, and the completion after that one is
theirs: Collie's attempt stays unresolved rather than taking it.

Where a harness has no way to report a failed compaction — Claude has no documented
compact-failed hook — the absence of success is an unresolved outcome and never a failure
nobody observed.

## Where the controls live

`<state>/compaction/<agent>/`: one directory per agent, holding its control record, the
generated helper where there is one, and the telemetry its own interface appends. Keyed by
agent rather than by Run, because an agent outlives the Run that launched it and a
hand-off gives another Run's Driver the same agent — including the in-flight attempt it
must not dispatch past.

Nothing persists copied conversation content or compaction summaries: identity, usage and
outcome only. A record that names a process names what that process is, too: control
records outlive the servers they describe, so a launch that signalled a recorded pid on
trust would eventually SIGTERM whatever the machine had since given that number to. The
pid is signalled only while `/proc/<pid>/cmdline` still contains the command it was
started with.

The helpers a launch installs are generated from Collie's own source, and a harness's
hook or status line is pointed back at this binary (`collie herdr compaction <dir>`)
rather than at a shell script parsing JSON with a `jq` the machine may not have. So what
a launch installs is by construction the code that installed it, one place validates an
untrusted payload, and `bun run smoke` proves it by asking the compiled binary to be that
helper. Every launch also puts down the controls, and any endpoint, of an agent herdr no
longer has.

## What has and has not been proved

Each adapter's accounting, identity and correlation is covered by tests against a
stand-in for that harness's interface, and each one's contract is checked against the
installed release itself: Codex's own `generate-json-schema`, OpenCode's own `/doc`, and
the version and launch flags of all four. The shared policy is covered at the engine and
hand-off seams with the real workflow engine.

Then all four were run for real: a herdr-launched agent per harness, through the compiled
binary, with the threshold lowered to 5,000 tokens, two pieces of work and nothing else.
Every one read its own context, asked its own harness to compact, and was given the second
piece of work once, after the compaction its own interface had confirmed — Claude at
56,122 tokens, Pi at 49,739, Codex at 104,369, OpenCode at 91,432. The five-minute pause
was seen for real too, on the Claude run that found the correlation bug below: no work
sent, the step blocked with the unresolved attempt named, and the attempt left on the
agent's record.

Four things only a live run could find, all fixed here:

- **Claude never confirmed a compaction.** `PostCompact` carries no `custom_instructions`,
  so nothing correlated and every Claude compaction ran out the five-minute budget.
- **Codex never read a context.** A TUI's own ephemeral thread made `thread/loaded/list`
  answer with two, and identity refused rather than ignoring it.
- **OpenCode never launched.** The wait for `serve` read a log the shell had not created
  yet, so the launch failed on a missing file.
- **OpenCode never had a usable sample.** A boundary lands while it is closing its last
  message, and only the newest message was read.

One thing outside this feature, found by the same runs: an OpenCode agent's first prompt
after launch is lost — the TUI is registered before it will take typed input, and the
session stays empty. It happens with `compact_at_tokens` set to `0` as well, so it is not
this feature's, and OpenCode's live proof above needed that first prompt sent again by
hand. Worth its own fix.
