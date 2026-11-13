# An owned server is checked apart from its terminal

**Status: proposed.** Applies [ADR-0059](0059-a-stopped-agent-is-stopped-where-its-turn-runs.md)'s ownership and Quiet requirements to automatic
recovery and clarifies [ADR-0062](0062-an-agents-question-is-asked-on-its-run.md)'s idle Output budget.

A terminal can remain listed after the managed server running its work exits.
Terminal status therefore cannot establish server health or bound that failure.

While Output is pending, the host observes its recorded managed endpoint separately
from terminal status. Each health probe is bounded. Continuous health failure or
uncertainty uses the existing readiness budget and produces a factual park.
Healthy work retains the existing idle budget, including its exemptions.
Collection continues after a health park and accepts late usable Output.

Replacement requires a sufficiently identified owned server, matched to the Run's
current incarnation, whose process is proven absent and whose endpoint is
unavailable. A failed inspection, live or reused PID, or timed-out endpoint probe
does not prove death. Only the existing agent-end path may retire the predecessor.
An exited server with a completely inspected empty surviving session can be Quiet;
an unknown surviving session cannot. Process-scan errors preserve uncertainty, and
an unreadable process is skipped only when its absence is independently proven.

After Quiet, recovery continues only the unfinished Step in the same Run and
checkout, using the existing conversation recovery behavior. Output is read before
retirement and again before replacement. Stop and competing recovery paths share
the existing incarnation and recovery safeguards.

Server loss never proves that earlier deliveries were not received. Existing
receipts remain intact, blocking uncertainty still blocks redispatch, and all new
deliveries pass through the Dispatcher. No completed Step is repeated.

The result is bounded failure visibility without a speculative second writer.
Where ownership or Quiet cannot be established, the Run retains the relevant
records and reports why recovery cannot proceed. The original exit cause remains
outside this decision.
