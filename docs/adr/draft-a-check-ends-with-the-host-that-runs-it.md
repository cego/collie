# A check ends with the host that runs it

**Status: accepted, to be built.** Amends
[ADR-0045](0045-collie-removes-what-it-made-once-nothing-needs-it.md) D1 (how a process is
proved) and D6 (which processes go with what owns them). Builds on
[ADR-0014](0014-native-workflows-run-on-effects-own-engine.md)'s bounded stop.

On vm-mk on 2026-10-19, 11 `bun run check` trees were running at once for three Runs
(run-1093d482, run-a43ff261, run-6e9ca5ca). Eight were 70 minutes to 2.6 hours old, had
been reparented to PID 1, and each led a process group of its own. Only the three newest
were children of the live host. That host had been restarted several times that day, once
from a shell without `bun` on PATH, then by the upgrades to 0.62.0 and 0.63.0. Load was
about 25 on 16 cores, and the live checks were at 41 minutes and more against a usual 23.
The eight were killed by hand.

Effect starts every child in a process group of its own, and ends that group only when the
Scope it was started in closes. A host's stop runs with `preemptiveShutdown: false` and,
since ADR-0014's 2026-10-07 amendment, exits five seconds after the signal. A running
check's step is never interrupted, so its Scope never closes and nothing ends its group. A
host that crashes or is killed ends nothing either. The next host knows nothing of the
check. It replays the step, and passes collected before it started are not relied on, so
the check runs again beside the one left behind. Each restart during a gate adds one more.
Within one host, a Run's passes run one after another, each waiting for its check to exit,
so a recheck or a fix round never leaves the one before it running.

## Decision

**D1. A check's processes are recorded and marked.** Every process Collie starts to collect
a verification, a gate's pass or an agent's `collie verify`, runs in a process group of
its own. Every process in that group carries a marker in its environment that names this
state directory's installation and the check. As the check starts, the host records it
under the state directory: the Run, the check, the pass, who asked, the group, its
leader's start time, and the host that started it. The record goes once the check's
verification is written or its processes are gone.

**D2. What proves a process is a check's.** A group is signalled only when its leader is
the recorded one, by pid and start time. Without that leader, each process that carries
the check's marker is signalled on its own, and only while it is still the process seen
carrying it, by pid and start time. A process proven by neither is never
signalled, and a reused pid proves nothing. The marker names the installation, so a host
never touches another state directory's checks. That matters because Collie's own suite
runs inside a check and starts hosts of its own.

**D3. A stop ends a host's checks. It does not wait for them.** Whatever ends a host ends
every check it is collecting first: a stop signal, its lock or directory gone, or the
process it watches gone. Those are one end, bounded by one grace. Before this, only a stop
signal was: a host whose lock went waited on its running steps for as long as they took.
Each check gets SIGTERM at once. Whatever is left of them gets SIGKILL in the grace's last
fifth, before the host lets go of its lock. A stop is not made to wait for a check to
finish, because a suite takes twenty minutes and more and the stop grace stays bounded
(ADR-0014). It does wait for the SIGKILL to be done: the group's kill, then a last look for
the check's marked processes and SIGKILL to any left, such as a child that left its group
late in the grace. That wait is bounded too, by a ceiling of three seconds past the grace. A
look at `/proc` took over a second on a loaded host, so three seconds holds one, and the
exit with its log flush stays inside the five seconds a client gives a stopping host
before it kills it. A newer look never waits on an older one: each look's answer is
signalled as it comes, because only the newer can see a process born since the older began.

**D4. A check Collie ended proves nothing.** It writes no verification, and the step that
ran it does not complete, so the next host runs it again. A failure recorded for a check
killed mid-run would otherwise stand for its tree
([ADR-0034](0034-a-check-red-before-the-run-is-reported-not-fixed.md), amended
2026-10-19).

**D5. A host that starts ends what the last one left. It never adopts it.** Before it
hands any Run back to the engine, a host ends every check of its state directory that a
previous host recorded or marked and that is still running: SIGTERM, then SIGKILL. It
removes the check's record, and the Run's `verifying` marker where that names the check.
The Run's log names each check ended, with the host that left it. The host never adopts
one, for three reasons:

- the check's output went to a pipe of the host that is gone;
- only a process's parent can read its exit status;
- the tree it started on was in that host's memory.

Running it again costs what a restart costs today, without the second copy.

**D6. One check of a Run at a time.** Before a check of a Run starts, any recorded check of
that Run that this host is not collecting is ended, once, by the bounded SIGTERM, SIGKILL
and last look. Whoever asked for the new check is told of each such leftover before its end
begins, by its check, pass, leader pid and the host that left it. One still running after
that end refuses the new check, naming it and its pid, rather than waiting on it: `collie
cleanup --apply` tries the end again. A host that is stopping starts no check either way. A
check whose collection is interrupted gets SIGTERM and then SIGKILL, never SIGTERM alone.

**D7. Cleanup and doctor see what is left.** A check process that no host is collecting is a
Cleanup kind. `collie cleanup` lists it with its Run, its check, its pid and how long it
has run. The sweep and `collie cleanup --apply` end it. `collie doctor` warns while one
is running and names `collie cleanup --apply` as the fix. A process with neither a record
nor a marker, such as one a build before this one left, is never Collie's to end.

**D8. A check is killed where an agent is not.** ADR-0059 never sends an agent SIGKILL:
Collie cannot vouch for a turn forced to end mid-write. A check's result is thrown away
and the check runs again, so nothing of it needs vouching for.

## Consequences

- A host restart during a check costs one more run of that check, as it did before, and
  never two copies running at once.
- A host whose lock or directory goes, or whose watched process exits, exits within the
  stop grace, as a signalled host does. Before, it waited on its running steps.
- A stop while a check runs takes the whole stop grace, because the check's step does not
  complete, and up to three seconds more while the SIGKILL's last look is under way.
- A Run's Stop still lets a check that is already running finish. Stop stops its agents,
  and that is unchanged here.
- Checks left behind by a build before this one carry no marker and have no record. A
  human ends them once.
- Where `/proc` cannot be read, as on macOS, no marker is read: `ps -E` runs a process's
  environment into its arguments, so nothing there tells a marker from text that quotes one.
  Only a check's recorded leader proves it, and a child that left its group is a human's to end.
