# A Run recovers where it parks, and what recurs is fixed in Collie

**Status: draft.** Decided by the grill step of run-6d5d5e1d, and revised there on the
human's review: a Heal before needs you (D7), and no gate on how a build spreads. It builds on
[ADR-0020](0020-an-agent-is-launched-once-and-its-output-is-decoded.md) (one launch, one
collection, one repair), [ADR-0021](0021-one-host-answers-for-a-run.md) and
[ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md) (one host
acts for a Run), [ADR-0037](0037-collie-corrects-by-default.md),
[ADR-0053](0053-collie-files-and-fixes-what-its-own-runs-show.md) (`self-improve`),
[ADR-0026](0026-a-shipped-workflow-is-a-module-like-any-other.md) (a Heal is a shipped
module) and [ADR-0058](0058-an-agent-speaks-to-another-as-itself.md) (a Heal speaks to the
Run's agents as itself). It relies on
[ADR-draft-a-fixable-failure-parks-its-step](draft-a-fixable-failure-parks-its-step.md)
(#301) turning a fixable failure into a park.

**Built so far:** D2 to D5, D6's records and report, and the Heal (D1's second step, D7, D9).
`self-improve`'s `park-<cause>` issues and the Heals' findings as its input (the rest of D6)
are decided, not built.

## What was true before

As of `cego/collie@c3005804` (0.123.1), on vm-mk:

- **Every park hands the next move to a person.** A park writes a sentence and raises
  `needs-you`. A suspended Run is resumed only by a person or an agent calling `resume`;
  nothing in the host resumes one, even when the reason it parked no longer holds.
- **An agent whose turn ended without writing its Output is waited on for two hours.**
  `collect` counts idle time only while herdr says the turn is over, then parks with
  "if it has stopped, ask it to write it". Nothing asks the agent itself. An Output that
  exists but does not decode gets one repair message; an absent one gets none.
- **The incident.** In run-c51a6621.improvement-the-mr-step-delivers-a-proved-head.implement,
  the `review-3-1` reviewer (pi) ended its turn at 2026-11-10T20:40:44Z with its verdict as
  its last chat message and never wrote `review-3-1.json`. Collie parked at 22:40:46. The
  host restarted at 06:46 and the collection began again. The human asked chat, chat
  delivered a nudge at 07:11:44, the file appeared at 07:12:14, and the Run went on to open
  #347. Collie had every fact it needed at 20:40:44. Chat saw only that the nudge was
  accepted; that the Run recovered was shown by the file, not by the nudge.
- **The baseline, 2026-10-28 to 2026-11-11.** 49 parks on 41 Runs.
  - _Agent idle, Output never written:_ 15 parks. Each took a median of 17.7 h, and at
    most 67.7 h, before the Run's next step.
  - _Check left to CI unproved:_ 11 parks, median 0.8 h.
  - _Release pipeline failed or conflicts:_ 5 parks.
  - _Gate fix unproved:_ 5 parks.
  - _Branch force-pushed:_ 5 parks.
  - _Forge listing timed out:_ 3 parks.
  - _No forge login:_ 2 parks.
  - _Dirty checkout:_ 2 parks.
  - _herdr down:_ 1 park.
  - _Human interventions:_ 28 human resumes, 12 of them refused (#301). 17 chat deliveries
    asked to "unblock / fix / retry" a Run, and 2 said "the agent is done but Collie has not
    picked it up".
  - _Restarts:_ 142 Runs saw a host restart. 32 of them parked or failed within a day.
- **What Collie does about its own defects.** The daily `self-improve` files a `defect` as
  an issue keyed by the triager's own kebab key. It builds up to `improvements` fixes
  (plan → implement, outcome `bug`), and a person merges them. A key only the triager
  chooses can drift from day to day. A fixed issue whose problem comes back is filed again
  rather than reopened.

## Decision

**D1. Recovery is decided by the host that owns the Run, deterministic steps first, then a Heal, then you.**

- **No new supervisor.** The host that owns the Run already serialises its work (ADR-0015,
  ADR-0029). It decides a park, and it decides that park's recovery.
- **The order of recovery:**
  1. what the cause itself can do: an Output reminder (D4) or a recheck and resume (D5);
  2. a **Heal** (D7), an agent the host starts for that one park;
  3. you, told what was tried and why only a person can move the Run.
- **Rejected: a watchdog Run or agent** that scans the board and steers through `collie_do`.
  - It would be a second actor racing the host.
  - It could judge only from the outside, by inactivity and by acknowledgements.
  - It would need a lease and a healer of its own.

  A Heal differs on each count:
  - the host starts it, for one park, under that park's claim;
  - it reads the Run's whole record;
  - its success is judged by the parked Run's own facts.

- **Rejected: a Heal first.** Every class in the baseline can be told apart from records
  Collie already has. A reminder or a recheck clears most parks in seconds, for no model
  turn. A Heal is for what they could not clear.

**D2. Every park names its Park cause.**

- **What a cause is:** a closed list kept in one module. Each park site passes a cause
  with its sentence. An unclassified park is the cause `unknown`, never a guess.
- **What each cause declares:**
  - **`asks the agent`:** a deterministic message to the Run's own agent, such as "write
    your Output".
  - **`rechecks`:** a read-only test of the fact that caused the park, such as "is job
    `test` in the pipeline at this head now?", "does the forge answer?" or "is the checkout
    clean?".
  - **`needs you`:** what the host cannot do about it alone, such as an Output still
    absent after two reminders, a failure that parks its Step for correcting (`step-failed`,
    [ADR-draft-a-fixable-failure-parks-its-step](draft-a-fixable-failure-parks-its-step.md)),
    or an `unknown` cause.
  - **`never heals`:** set on a cause only a person can act on, such as a missing login, a
    force-push or a human's dirty checkout. That park goes straight to you, without a Heal
    (D7).
- **What it shows:** the cause, each recovery action taken, and that action's outcome. The
  Run's record shows them, and so do the card, `run show` and chat's reads.

**D3. Diagnosis is read from facts first, and recovery never touches certain states.**

- **Never touched:** an open Decision, a Hold, a Stop, a Superseded question's work, an
  agent herdr reports `working` or `blocked`, or a Short of memory wait.
- **Slow work is not stuck work.** A turn that is still working is never interrupted.
  Its step's duration against the last ten (`step-durations`) is shown as "longer than
  usual" and starts nothing.
- **A model diagnoses only once the facts could not clear the park:** a Heal (D7) diagnoses
  that one park, and `self-improve`'s triage (D6) diagnoses what recurs.
- **Inactivity and acknowledgement prove nothing.** Recovery is proved only by the fact the
  park was waiting for: the Output decodes, the job is in the pipeline, the step is left.
  A delivery that was `observed` is a try, not a recovery.

**D4. An agent whose turn ended without its Output is asked to write it, at once.**

- **When:** `collect` sees the turn end (herdr reports the agent was working and now is not)
  with the Output absent.
- **What is sent:** an Output reminder through the Dispatcher, cause `repair`, naming
  `OUTPUT_PATH`. It says that a chat message is not the Output.
- **How often:** at most two reminders per launch. Each is its own Activity, so a replay
  sends none again.
- **Then:** an Output still absent after the second reminder's turn ends parks with cause
  `output-absent`, which goes to a Heal (D7) before it needs you.
- **The two-hour idle budget** stays as the backstop where the turn's end cannot be read.
- **Rejected: taking the Output from the agent's transcript.** That would be Collie
  writing the agent's result for it.

**D5. A suspended park is resumed when its recheck says the cause has cleared.**

- **Who rechecks:** a host side-job rechecks each suspended park whose cause `rechecks`.
  It uses exponential backoff from 1 minute to 1 hour, and starts again from 1 minute on
  the matching event (a Machine reconnecting, a pipeline update, a host start).
- **How a cleared park resumes:** through the same `resume` executor a person uses. The
  Actor is `host` and the request id is `recover:<run>:<park>:<n>`, so a repeat is the
  same control (ADR-0017, ADR-draft-an-admitted-control-runs-to-its-end). The Step then
  checks again itself; a recheck never stands in for the Step's own gate.
- **Budget:** three automatic resumes per Run per cause. A park that comes back with the
  same cause after its third resume goes to a Heal (D7), and then to you, saying what was
  tried. At most
  two automatic resumes run at once per Machine, and none starts while the Machine is Short
  of memory.
- **Setting:** `recovery.resume`, default `on`. Asking a person to resume a Run whose
  cause provably cleared protects nothing (invariant 1, ADR-0037).

**D6. A recovery is evidence, and a cause that recurs is a defect with a stable key.**

- **What is recorded:** every park and every recovery action is a line in the Run's
  `metrics.jsonl`, with its cause, action, outcome and the Collie build that ran it.
  `collie run report` and `outcomes.ts` count parks, recoveries, false recoveries (an
  automatic resume that re-parks with the same cause) and time to recover, per cause.
- **How `self-improve` files it:** a Collie `defect` that comes from parks is keyed
  `park-<cause>`, not by a key the triager chose, so it is the same issue every day.
  `unknown` parks are triaged as today. Their fix is a new cause with its recheck or
  message, or the root-cause fix that makes the park unnecessary.
- **The Heals' findings are its input too:** they are clustered by key alongside the parks.
  A finding is filed on Collie's own repository as the general defect, for everyone who
  runs Collie. It names the affected Runs by id and leaves out the project's own details.
- **A Heal's defect is reported as it is judged, not left to a later triage:** the host
  files it on github.com/cego/collie, or links the issue for the same cause that the healer
  named or that carries its key, and keeps the standing and the issue on the parked Run as
  a `report` metrics line. A refused or uncertain report is tried again, listing first.
- **Reopened, not refiled:** a cause key that recurs on a build that already contains its
  fixing commit reopens the closed issue. The comment names the new Runs and the build.
- **Proof that a fix worked:** the affected Runs, which are named on the issue, recover
  through D5 or D7 once their host runs the fix, and the cause does not recur for seven days.
  Until then the issue says "fixed in <build>, not yet proved".

**D7. A park recovery could not clear gets a Heal before it needs you.**

- **When:** a park's cause either needs you, or has spent its recheck budget. Before the host
  raises needs you, it starts one Heal for that park.
  - The request id is `heal:<run>:<park>`, so a repeat is the same Heal.
  - A cause can declare that it never heals, because only a person can act on it: a missing
    login, a force-pushed branch, a human's dirty checkout. Those go straight to you.
- **What a Heal is:** a Run of a shipped workflow, a module like any other (ADR-0026). It
  runs on the parked Run's Machine and in its Task's workspace.
- **What it may read:** the parked Run's whole record, its agents' panes and transcripts, its
  checks and its pipeline.
- **What it may do,** on the parked Run only and through the executors a person uses:
  - deliver a message to the Run's own agents;
  - resume the Run.

  Work in the repository is done by the Run's own agents, so the Run's repository scope
  holds.

- **What it may not do:**
  - answer a Decision, lift a Hold, undo a Stop or confirm a Proposal;
  - change the Run's Intent or its checks;
  - start or take an offer on another Run;
  - write an Output for an agent.

  The host gives the Heal only the two actions it may take. The concrete harm this prevents
  is an agent nobody asked answering for you on a question put to you.

- **Proof:** the Heal's Output is a claim. The host counts a park recovered only when the
  parked Run leaves its park with the fact the park waited for (D3). A Heal that says
  "resolved" while the Run is still parked is a false recovery, and the park becomes needs
  you.
- **What it hands on:**
  - **when it escalates:** its diagnosis, every action it took, and why only a person can
    move the Run. That is the needs-you you see.
  - **the self-improvement finding:** every Heal also writes one, whether it fixed the Run or
    not. The finding records:
    - whether Collie has a defect here;
    - the general root cause, stated without the project's own details;
    - the fix that would make the park unnecessary, or a new Park cause with its message or
      recheck;
    - the regression test that would show it.

    It is written for Collie as everyone runs it, not for this Machine. A local workaround
    is not a finding.
- **Budget:**
  - one Heal per park;
  - three per Run in total;
  - one running at a time per Machine;
  - none while the Machine is Short of memory.

  A Run started as a Heal is never healed itself: its park goes to you at once, and so does
  the park it was healing.

- **Setting:** `recovery.heal`, default `on`. A Heal's usage is recorded with its Run and
  never enforced (invariant 8).
- **What you see:** while a Heal runs, the card says the Run is being healed and nobody is
  notified. You are told once, when the Heal recovers the Run or escalates.

**D8. Authority: what this grants, and what it does not.**

- **Already granted, and kept:**
  - repairing an Output, reviving a lost agent, falling back, correcting drift;
  - `self-improve` filing issues and opening Improvement merge requests;
  - a newer Machine upgrading an older peer, unchanged by this decision.
- **Granted by this decision:**
  - the Output reminder (D4);
  - the automatic resume of a cleared park (D5);
  - reopening a recurred issue (D6);
  - a Heal delivering to a parked Run's agents and resuming it (D7).
- **Not granted, and recommended to stay with a person:**
  - merging an Improvement (ADR-0053 D8);
  - tagging or publishing a Collie release;
  - deploying or rolling back a build on a Machine.

  If they are ever granted, each is its own setting, defaulting to off, and binds an agent
  as it binds a person. This decision builds none of them.

- **Never:** no recovery, and no Heal, ever:
  - answers a Decision, lifts a Hold, undoes a Stop or confirms a Proposal;
  - passes a gate on a claim;
  - records success without the fact D3 names.

**D9. When the healer fails.**

- **A recheck round that errors** is skipped and counted.
- **A Heal that fails or parks** sends its parked Run to you at once, with whatever the Heal
  found.
- **Three failed recheck rounds, or three failed Heals, in a row** raise one News item,
  "recovery is failing on <Machine>". It is keyed so it is said once while it holds. Runs
  then wait for people, as they do today.
- **A host that dies** loses no recovery state. The state is the park records, the resume
  claims and the Heal's own Run. The next host rechecks from them, and finds a Heal already
  started by its request id.

## Consequences

- **The incident** would have taken seconds: a reminder at 20:40, and the file within the
  reviewer's next turn.
- **Parks that only waited for a fact to change** resume by themselves, and the card says so.
  Examples: a CI job appearing, the forge answering, herdr coming back, a checkout made
  clean.
- **What the 17 "unblock / fix / retry" chat deliveries did** is what a Heal does, before
  anyone is asked.
- **What still needs a person** says why, and says what was tried.
- **A defect Collie keeps hitting** has one issue that collects its Runs and the Heals'
  findings. It is reopened if its fix did not hold.
- **Not decided here:**
  - reading another Machine's Runs from one place;
  - retrying an Improvement that started and then failed;
  - how a new build reaches the Flock;
  - granting any of D8's withheld authority.

CONTEXT.md's **Park cause**, **Recovery** and **Heal** entries name these terms.
