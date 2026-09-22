// A list of work, as a module writes one: enumerate, handle each item, summarise.
//
// There is no list language here. The list is the plan's own tickets, read again on every
// pass so an edit to the plan is work that changed rather than work that was frozen. The
// loop is `Effect.forEach`. What makes an item recoverable is its identity — the ticket's
// file name, which its agent's work is recorded under — so reordering the plan reuses
// what is done and moves only what is left.
//
// Two entries share this body under two unrelated public ids, because none of it reads a
// name to decide what to do.

import {
  FixOutputSchema,
  NativeHost,
  WorkflowError,
  agentWork,
  ask,
  decision,
  defineWorkflow,
  identityProblem,
  isBlocking,
  orderedTicketsOf,
  renderProgress,
  type Finding,
  type Handed,
  type WorkflowMetadata,
} from "collie/native";
import { Effect, Schema } from "effect";

export const input = {
  /** The plan whose tickets are the list. Read on every pass, never frozen. */
  plan: Schema.String,
  cwd: Schema.String,
};

export const metadata: WorkflowMetadata = {
  hints: { plan: "work-source" },
  outcome: { fixed: "feature" },
};

/** One agent for the whole list, so the item after this one is a hand-off, not a re-read. */
const IMPLEMENTER = "implementer";

const INSTRUCTIONS = `Build {{inputs.ticket}} — {{inputs.title}}, item {{inputs.at}} of {{inputs.of}}.

What the items before it left:

{{inputs.progress}}`;

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const carryOn = decision("carry-on", {
    prompt: "Findings were raised. Carry on?",
    options: ["yes", "no"],
  });

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* NativeHost;
      const { runId, input: asked } = payload;
      const tickets = yield* orderedTicketsOf(asked.plan);
      // Identities before work: two items nobody can tell apart would share one result,
      // and finding that out after an agent has been paid for is finding out too late.
      const problem = identityProblem(tickets.map((ticket) => ticket.file));
      if (problem !== null) return yield* new WorkflowError({ reason: problem });
      if (tickets.length === 0) return "nothing to do";

      const handed: Handed[] = [];
      const findings: Finding[] = [];
      for (const [at, ticket] of tickets.entries()) {
        // Eligibility before anything expensive: a ticket nothing would prove is not
        // handed to anyone, and the reason is recorded rather than written as an Output.
        if (ticket.checks.length === 0) {
          yield* host.record(runId, `skipped ${ticket.file}: it names no checks`);
          continue;
        }
        const built = yield* agentWork({
          runId,
          operation: ticket.file,
          agent: IMPLEMENTER,
          role: "implementer",
          cwd: asked.cwd,
          instructions: INSTRUCTIONS,
          inputs: {
            ticket: ticket.file,
            title: ticket.title,
            at: at + 1,
            of: tickets.length,
            progress: renderProgress(handed),
          },
          output: FixOutputSchema,
        });
        // Findings do not stop the list: they are carried, and the summary is where they
        // add up.
        findings.push(...built.findings);
        handed.push({
          item: ticket.file,
          title: ticket.title,
          commits: built.fixed.map((one) => one.title),
        });
      }

      const summary = handed.map((one) => `${one.item}=${one.commits.join("/")}`).join("+");
      // A question only where there is something to ask about, and durable when there is.
      if (findings.some(isBlocking)) {
        const answer = yield* ask(runId, carryOn);
        if (answer !== "yes") return `stopped: ${findings.length} finding(s), ${summary}`;
      }
      return `${handed.length} of ${tickets.length}: ${summary}, ${findings.length} finding(s)`;
    }),
  );

  return { workflow, layer, decisions: { "carry-on": carryOn } };
};
