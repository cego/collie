# Local implementation tickets

Generated from `SPEC.md` on 2026-08-31 at commit `8533866`. These tickets are
local only: do not publish them to GitLab, Linear, or another tracker without a
separate explicit request.

Read the specification before taking a ticket. Work the frontier: any ticket
whose blockers are complete may start.

## Execution order and status

| Ticket | Title | Blocked by | Status |
| --- | --- | --- | --- |
| 01 | Confine Workflow-generated paths to the Run | — | READY FOR AGENT |
| 02 | Give each Run one verified Driver owner | — | READY FOR AGENT |
| 03 | Preserve Hand-offs across concurrent Run saves | — | READY FOR AGENT |
| 04 | Make local process paths shell-safe | — | READY FOR AGENT |
| 05 | Accelerate the full behavioural test suite | 01, 02, 03, 04 | BLOCKED |
| 06 | Make typechecking a documented repository command | — | READY FOR AGENT |
| 07 | Align canonical documentation with shipped behaviour | — | READY FOR AGENT |

Status values: READY FOR AGENT | IN PROGRESS | DONE | BLOCKED (with reason) |
REJECTED (with reason)

## Dependency notes

- Tickets 01–04 establish the final safety and coordination coverage.
- Ticket 05 follows all four so its timing target includes that coverage and it
  optimizes the final test workload rather than an obsolete baseline.
- Tickets 06 and 07 are independent and can run alongside tickets 01–04.

## Explicitly excluded

- Publishing a binary release, version tag, or package (audit finding 4).
- Any remote issue, merge-request, release, or Linear operation.

