// A goal, interviewed into a spec and tickets, and then the menu that decides what
// becomes of them.
//
// Three pieces of work on one planner, so its model is the workflow's own default and the
// interview it held is still in the agent that writes the spec. Then a question, and another after
// whatever the answer started — a plan is refined, second-guessed and offloaded as often
// as the human wants, and only "Implement now", "Architecture first" and "Finish
// planning" end it.
//
// The Markdown beside this file is the content: the interview, the two skills the spec
// and the tickets are written with, and what each of the menu's rounds asks for.

import {
  FindingSchema,
  Children,
  Host,
  PlanOutputSchema,
  ReviewOutputSchema,
  Run,
  WorkflowError,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
  formatFindings,
  planReposOf,
} from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import markdown from "./plan.md" with { type: "text" };

const content = contentOf(markdown);
const prompt = (section: string) =>
  [content.preamble, content.sections.get(section) ?? ""]
    .filter((part) => part !== "")
    .join("\n\n");

/** What the interview settles: the name of the work, and what kind of result it is. */
const Grilled = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  slug: Schema.String.annotate({ description: "short kebab-case name for this work" }),
  outcome: Schema.String.annotate({
    description:
      "one of feature, bug, refactor, investigation, docs or migration — empty where none fits",
  }),
  decided: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "what we settled, one line each",
  }),
});

/** What the spec step leaves behind. The tickets step writes the plan's own Output. */
const Spec = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  spec: Schema.String.annotate({ description: "the spec you wrote, as a path" }),
});

/** What a round that rewrote the plan says to whoever is already building from it. */
const Revised = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  disputed: Schema.optionalKey(Schema.Array(FindingSchema)),
  changed: Schema.optionalKey(Schema.Array(Schema.String)),
  changelog: Schema.String.annotate({
    description:
      "one or two sentences on what changed in the plan, written for an implementer already building from it",
  }),
});

const Offloaded = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  issue: Schema.String.annotate({ description: "the id of the one issue you created" }),
  url: Schema.String,
});

/** The host's own options for a child, with the ones nobody settled left out: absent
 *  rather than empty, exactly as a front door passes them. */
const launch = (options: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== ""));

const IMPLEMENT = "Implement now";
const ARCHITECTURE = "Architecture first";
const OPINION = "Second opinion";
const OFFLOAD = "Offload to Linear";
const REFINE = "Refine";
const FINISH = "Finish planning";
const CHOICES = [IMPLEMENT, ARCHITECTURE, OPINION, OFFLOAD, REFINE, FINISH];

/**
 * How often the menu may come back. Everything that is not terminal returns to it, so the
 * bound is what stops a plan nobody is finishing from asking for ever; a run that reaches
 * it says so rather than asking a seventh time.
 */
const ROUNDS = 6;

/** A second opinion is worth having twice at most; after that it is the same plan again. */
const OPINIONS = 2;

/** The planner is one agent for the whole run. */
const PLANNER = "grill";

export default defineWorkflow({
  id: "plan",
  title: "plan — turn a goal into a spec and tickets",
  description:
    "Uses the goal and repository context to write a spec and tickets, asking only for missing decisions.",
  input: Schema.Struct({
    goal: Schema.String,
    ticket: Schema.optionalKey(Schema.String),
  }),
  output: Schema.String,
  // The planner's own, which a Run's --model or a scope around it can still change.
  agents: { harness: "claude", model: "fable", effort: "medium" },
  hints: { goal: "goal", ticket: "ticket" },
  // A plan proves it wrote tickets; nobody chooses that, so it is fixed rather than asked.
  outcome: { fixed: "plan" },
  // What a finished plan offers: the tickets it wrote, built by the workflow that builds.
  followUps: [
    {
      id: "implement-now",
      title: "Implement now",
      workflow: "implement",
      when: "succeeded",
      inputs: { plan: "plan-dir" },
    },
  ],
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const children = yield* Children;
      const run = yield* Run;
      const place = yield* host.place(run.id);
      const inputs = { goal: asked.goal, ticket: asked.ticket ?? "" };
      const vars = { run: { dir: place.dir, id: run.id } };
      const planDir = `${place.dir}/plan`;
      // Why the plan's tickets cannot be built, recorded so a replay is handed the same answer.
      const refusalOf = (at: string) =>
        Activity.make({
          name: `repos.${at}`,
          success: Schema.NullOr(Schema.String),
          execute: planReposOf(planDir, place.cwd).pipe(
            Effect.map((plan) => plan.refusal?.message ?? null),
          ),
        });
      const planner = { agent: PLANNER, role: "planner", inputs };

      const grilled = yield* agentWork({
        ...planner,
        operation: "grill",
        instructions: prompt("grill"),
        vars,
        output: Grilled,
      });
      yield* agentWork({
        ...planner,
        operation: "spec",
        skill: "to-spec",
        instructions: prompt("spec"),
        vars,
        output: Spec,
      });
      const written = yield* agentWork({
        ...planner,
        operation: "tickets",
        skill: "to-tickets",
        instructions: prompt("tickets"),
        vars,
        output: PlanOutputSchema,
      });
      // A plan whose tickets nobody can build is not a finished plan: its planner is told once.
      const refusal = yield* refusalOf("tickets");
      if (refusal !== null) {
        yield* agentWork({
          ...planner,
          operation: "unbuildable",
          instructions: prompt("unbuildable"),
          vars: { ...vars, refusal },
          output: PlanOutputSchema,
        });
        const still = yield* refusalOf("unbuildable");
        if (still !== null) return yield* new WorkflowError({ reason: still });
      }

      let opinions = 0;
      for (let round = 1; round <= ROUNDS; round++) {
        // What is left to offer: an opinion already had twice is not offered a third time.
        const chosen = yield* ask({
          name: `next-${round}`,
          prompt: "What next?",
          options: opinions < OPINIONS ? CHOICES : CHOICES.filter((one) => one !== OPINION),
        });
        if (chosen === FINISH) return `${written.issues_dir}: finished planning`;

        if (chosen === IMPLEMENT) {
          // A plan the fan-out cannot run starts nothing, and the menu comes back.
          const unrunnable = yield* refusalOf(`implement-${round}`);
          if (unrunnable !== null) {
            yield* host.record(run.id, `${IMPLEMENT} cannot run here: ${unrunnable}`);
            yield* host.parked(run.id, `${IMPLEMENT} cannot run here: ${unrunnable}`);
            continue;
          }
          yield* host.parked(run.id, null);
        }

        if (chosen === IMPLEMENT || chosen === ARCHITECTURE) {
          const building = chosen === IMPLEMENT;
          const child = yield* children.start({
            invocation: building ? "implement" : "architecture",
            workflow: building ? "implement" : "architecture",
            input: building ? { plan: planDir } : {},
            // What kind of result this is, and what it is called: settled during the
            // interview rather than asked for again at the start of the build.
            options: launch({
              task: building ? grilled.slug : "",
              outcome: building ? grilled.outcome : "",
            }),
          });
          yield* children.result(child);
          return `${written.issues_dir}: ${chosen} as ${child.runId}`;
        }

        if (chosen === OPINION) {
          opinions += 1;
          // A reviewer of its own, on its own agent: the planner that wrote the plan is
          // the last one who can tell you what is wrong with it.
          const opinion = yield* agentWork({
            operation: `second-opinion-${opinions}`,
            role: "reviewer",
            model: "opus",
            effort: "xhigh",
            instructions: prompt("second-opinion"),
            inputs,
            vars,
            output: ReviewOutputSchema,
          });
          // A second opinion with nothing to say is not a round of revision.
          if (opinion.findings.length === 0) continue;
          yield* agentWork({
            ...planner,
            operation: `revise-${opinions}`,
            instructions: prompt("revise"),
            vars: { ...vars, findings: formatFindings(opinion.findings) },
            output: Revised,
          });
          continue;
        }

        if (chosen === OFFLOAD) {
          const board = yield* ask({
            name: "linear-team",
            prompt: "Which Linear team do new issues go to",
          });
          yield* agentWork({
            ...planner,
            operation: `offload-${round}`,
            instructions: prompt("offload"),
            vars: { ...vars, config: { linear: { team: board } } },
            output: Offloaded,
          });
          continue;
        }

        yield* agentWork({
          ...planner,
          operation: `refine-${round}`,
          instructions: prompt("refine"),
          vars,
          output: Revised,
        });
      }
      return `${written.issues_dir}: asked ${ROUNDS} times what to do next`;
    }),
});
