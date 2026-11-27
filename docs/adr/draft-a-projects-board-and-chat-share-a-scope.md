# A Project’s board and chat share a scope

**Status: accepted, to be built.**

Desktop currently has one Flock chat with access to work across Machines. The existing
board Filter changes what an operator sees. When an operator switches to a Project to
concentrate on one piece of the business, they also need to know where a chat request
such as “show me the open reviews” or “resume this Run” will apply.

The sidebar puts Projects below its main links, including Proposals and Guidance.
Settings stays at the bottom while the Project list scrolls. One click on a Project opens its
board and resumes its Project chat. Desktop already groups the Runs for a piece of work
on one Task card. Selecting a Project narrows the set of Tasks on the board.
[Board decision](0013-the-board-is-cards-of-tasks.md)

The selected Project bounds what its chat can read and act on. This
includes tools that reach files or a shell. Every request carries the scope in which
it was sent, including when the operator switches Projects before a reply arrives.
The global Board remains one click away and reopens its own Flock chat.

Operators can star a Project to move it to the top of the Projects section and archive
a Project to put it away. Projects are peers. For example, CEGO Platform and Payments
can sit beside each other. Stars affect sidebar order. Each Project shows the number
of Tasks that need the operator, and the global Board includes escalations from every
Project regardless of its star.

Operators can follow an individual Task across all its Runs. Both the global Board
and a Project board offer a Following filter within their current scope. A followed
Task stays in its actual status section as work progresses. Following expresses the
operator’s interest. Needs you indicates a decision that requires the operator.

Archiving puts the selected Project in the sidebar’s archive. Its Runs continue and their
records remain accessible on the global Board. Restoring the Project brings its shortcut
and conversation back.

Existing Tasks can stay unassigned on the global Board. The operator can select and
file several at once. An assigned Task has one home Project at a time, even when its
Runs span repositories. Moving it preserves its Runs, discussion and open questions.
Flock chat can ask the relevant Project Managers for their
findings and bring the answers back into the global conversation. Archived Projects’
escalations and pending guidance proposals remain visible in their global views.

A Collie Project has its own identity. An optional Linear project supplies planning
context. Changing the link preserves the Collie Tasks, Runs and conversation. Choosing
an issue for work creates a Task even before its first Run. Project chat can consult
the wider Linear backlog while the board shows only work taken into Collie.

Adding a Task queues it and preserves the operator’s instructions before the first
Run. An instruction to carry out the work authorizes the Project Manager to choose
a Workflow, start Runs and follow through. The operator can delegate an outcome in
one request, including when the Task has yet to be created.

The Task is the shared record and message board for its operator and agents. A new
Run receives the goal, decisions, evidence and open questions with their sources.
Agents working in parallel on the same Task share that context, including agents
within a single Run. The operator can inspect the handoff each Run received.

Every agent on the Task can post findings and challenge a decision. The agreed
decision and the challenge stay visible together until someone with authority
explicitly resolves the conflict. Agents already working receive relevant updates
at their next opportunity to act. An explicit stop or redirect can interrupt work.

Choosing the same Linear issue again reopens its existing Collie Task by default.
Starting a separate Task for a distinct outcome is an explicit choice.

Work can also start in Collie. An operator can publish an existing Task as a Linear
issue and link the two in one action. The same Collie Task carries its Runs,
discussion and decisions before and after publication.

Publishing also works from a standalone Collie Project. Collie handles issue creation
and linking together.

The Project Manager maintains the Project and its Tasks over time. A Task agent can
ask it to judge a local implementation choice against the Project’s architecture and
earlier decisions. Its remit includes composability, flexibility, ease of testing,
performance and usability for both agents and humans. Its context is scoped to the
Project and the Task under discussion.

Flock chat and all Project Managers share one harness, model and reasoning effort
setting. The controls in either chat make that shared scope explicit. A change takes
effect on the next turn. A turn in progress finishes with its original settings.
Workflow Runs keep their own configuration.

Each Project owns one current handover across chat sessions and harness changes.
It lists open commitments with links to their Tasks and Runs. The Manager updates
an entry as replies arrive, checks its source when it grows stale, and closes it
once fulfilled or cancelled. Age alone does not close a commitment. The operator
can inspect and correct the handover. Completed commitments remain traceable on
their Tasks. Each question brings in the relevant entries and source records.
Handover maintenance leaves changes to standing guidance subject to operator approval.

Project chat reaches that Project’s Manager. The operator can discuss an outcome once
and leave the Manager to brief the relevant Runs and agents, relay their findings,
settle technical disagreements and record decisions on the Task. It acts on reversible
choices and escalates to the operator before a destructive action that would be
difficult to undo. A request to publish a Task authorizes the Manager to create or
link the Linear issue and report the result on the Task.

Needs you counts Tasks that require the operator. Agent questions the Manager can
settle stay on their Task, alongside the Manager’s answer. The Manager can apply a
decision to the current Task and propose it as guidance for future Tasks. The
operator can accept, edit or reject the proposal. Only the wording the operator
accepts becomes standing Project guidance.

Pending guidance proposals wait for review while work continues. Global Proposals
shows proposals from all Projects with their originating Project. Opening Proposals
within a Project shows that Project’s proposals. Both views act on the same proposal.

The Manager keeps a linked Linear issue current with meaningful changes to delivery,
including blockers and verified outcomes. Routine correspondence stays on the Task.

The Task record brings together its merge requests, reviews, discussion, evidence,
Runs and live agents. A change retains its forge identity across contributing Runs.
An operator can open an exact review location or agent terminal directly from the
Task. The Task workspace design and acceptance walkthrough retained with planning Run
`run-d44de620` describe the interactions and native behaviors to preserve.
