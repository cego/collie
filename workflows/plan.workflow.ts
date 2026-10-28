// A goal, interviewed into a spec and tickets, and then the menu that decides what
// becomes of them.
//
// Three pieces of work on one planner, so its model is the workflow's own default and the
// interview it held is still in the agent that writes the spec. Then a question, and another after
// whatever the answer started — a plan is refined, second-guessed and offloaded as often
// as the human wants, and only "Implement now", "Architecture first" and "Finish
// planning" end it. Started with `then=implement`, nobody is asked anything: the plan is
// built as soon as it is written.
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
  renderApproved,
  step,
  type VerifySpec,
} from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import markdown from "./plan.md" with { type: "text" };

const content = contentOf(markdown);
const text = Schema.String;

/** What every planning prompt is told: what to plan, and where this Run keeps its work. */
const planning = {
  inputs: Schema.Struct({ goal: text }),
  run: Schema.Struct({ dir: text, id: text }),
  rooting: text,
  attendance: text,
};

const prompts = {
  grill: content.template("grill", planning),
  spec: content.template("spec", planning),
  tickets: content.template("tickets", { ...planning, checks: text }),
  unbuildable: content.template("unbuildable", { ...planning, refusal: text }),
  secondOpinion: content.template("second-opinion", planning),
  revise: content.template("revise", { ...planning, findings: text }),
  offload: content.template("offload", {
    ...planning,
    config: Schema.Struct({ linear: Schema.Struct({ team: text }) }),
  }),
  refine: content.template("refine", planning),
};

const checksOf = (approved: ReadonlyArray<VerifySpec>) =>
  approved.length === 0 ? "" : `\n\nThis Run's Checks:\n\n${renderApproved(approved)}`;

const Decided = Schema.optionalKey(Schema.Array(Schema.String)).annotate({
  description: "what we settled, one line each",
});

/** What the interview settles: the name of the work, and what kind of result it is. */
const Grilled = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  slug: Schema.String.annotate({ description: "short kebab-case name for this work" }),
  outcome: Schema.String.annotate({
    description:
      "one of feature, bug, refactor, investigation, docs or migration — empty where none fits",
  }),
  decided: Decided,
});

/** What the spec step leaves behind. The tickets step writes the plan's own Output. */
const Spec = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  spec: Schema.String.annotate({ description: "the spec you wrote, as a path" }),
  decided: Decided,
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

/** What a planner rooted at the Projects root is told about it, and nothing elsewhere. */
const rootingOf = (options: Readonly<Record<string, string>>) =>
  options.workspace === "projects-root" ? (content.sections.get("projects-root") ?? "") : "";

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

const grill = step({
  id: "grill",
  title: "Grill",
  description:
    "The planner reads the goal and the repository, and asks only what changes the work.",
  kind: "agent",
  role: "planner",
});
const spec = step({
  id: "spec",
  title: "Spec",
  description: "The planner writes SPEC.md into the Run's plan directory.",
  kind: "agent",
  role: "planner",
  produces: "plan",
});
const tickets = step({
  id: "tickets",
  title: "Tickets",
  description: "The planner writes one ticket per slice beside the spec.",
  kind: "agent",
  role: "planner",
  produces: "plan",
});
const menu = step({
  id: "menu",
  title: "End menu",
  description: "What becomes of the plan: built, second-guessed, offloaded, refined or finished.",
  kind: "question",
});
const unbuildable = step({
  id: "unbuildable",
  title: "Unbuildable",
  description: "The planner is told once why its tickets cannot be built.",
  kind: "agent",
  role: "planner",
  produces: "plan",
});
const opinion = step({
  id: "second-opinion",
  title: "Second opinion",
  description: "A reviewer of its own reads the plan.",
  kind: "agent",
  role: "reviewer",
  produces: "review",
});
const revise = step({
  id: "revise",
  title: "Revise",
  description: "The planner answers the second opinion's findings.",
  kind: "agent",
  role: "planner",
  produces: "plan",
});
const offload = step({
  id: "offload",
  title: "Offload to Linear",
  description: "The planner files the tickets as Linear issues, in the team it was told.",
  kind: "agent",
  role: "planner",
});
const refine = step({
  id: "refine",
  title: "Refine",
  description: "Another planner round over the plan.",
  kind: "agent",
  role: "planner",
  produces: "plan",
});

export default defineWorkflow({
  id: "plan",
  title: "plan — turn a goal into a spec and tickets",
  description:
    "Turns a goal into a spec and tickets, using the repository for context and asking only for missing decisions.",
  input: Schema.Struct({
    goal: Schema.String,
    then: Schema.optionalKey(
      Schema.Literals(["", "implement"]).annotate({
        description:
          "implement to build the plan as soon as it is written, with nobody asked anything; empty to be asked what next",
      }),
    ),
  }),
  output: Schema.String,
  // The planner's own, which a Run's --model or a scope around it can still change, and a
  // second opinion's: a fresh agent with its own context.
  agents: {
    harness: "claude",
    model: "opus",
    effort: "high",
    roles: { reviewer: { harness: "claude", model: "opus", effort: "high" } },
  },
  hints: { goal: "goal" },
  path: [grill, spec, tickets, menu],
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
      const nobodyAsked = asked.then === "implement";
      const input = {
        inputs: { goal: asked.goal },
        run: { dir: place.dir, id: run.id },
        rooting: rootingOf(place.options),
        // A section's text is sent as it is, so the one name it carries is filled here.
        attendance: (
          content.sections.get(nobodyAsked ? "unattended" : "attended") ?? ""
        ).replaceAll("{{run.id}}", run.id),
      };
      const planDir = `${place.dir}/plan`;
      // Why the plan's tickets cannot be built, recorded so a replay is handed the same answer.
      const refusalOf = (at: string) =>
        Activity.make({
          name: `repos.${at}`,
          success: Schema.NullOr(Schema.String),
          execute: planReposOf(planDir, place.cwd).pipe(
            Effect.map((plan) => plan.refusal?.message ?? null),
            Effect.catch((cause) =>
              Effect.succeed(`the plan at ${planDir} could not be read: ${cause.message}`),
            ),
          ),
        });
      const planner = { agent: PLANNER, role: "planner" };

      const grilled = yield* grill(
        agentWork({
          ...planner,
          operation: "grill",
          instructions: prompts.grill,
          input,
          output: Grilled,
        }),
      );
      yield* spec(
        agentWork({
          ...planner,
          operation: "spec",
          skill: "to-spec",
          instructions: prompts.spec,
          input,
          output: Spec,
        }),
      );
      const written = yield* tickets(
        agentWork({
          ...planner,
          operation: "tickets",
          skill: "to-tickets",
          instructions: prompts.tickets,
          input: { ...input, checks: checksOf(yield* host.approved(run.id)) },
          output: PlanOutputSchema,
        }),
      );
      // A plan whose tickets nobody can build is not a finished plan: its planner is told once.
      const refusal = yield* refusalOf("tickets");
      if (refusal !== null) {
        yield* unbuildable(
          agentWork({
            ...planner,
            operation: "unbuildable",
            instructions: prompts.unbuildable,
            input: { ...input, refusal },
            output: PlanOutputSchema,
          }),
        );
        const still = yield* refusalOf("unbuildable");
        if (still !== null) return yield* new WorkflowError({ reason: still });
      }

      let opinions = 0;
      for (let round = 1; round <= ROUNDS; round++) {
        // What is left to offer: an opinion already had twice is not offered a third time.
        const chosen = nobodyAsked
          ? IMPLEMENT
          : yield* menu(
              ask({
                name: `next-${round}`,
                prompt: "What next?",
                options: opinions < OPINIONS ? CHOICES : CHOICES.filter((one) => one !== OPINION),
              }),
              { round },
            );
        if (chosen === FINISH) return `${written.issues_dir}: finished planning`;

        if (chosen === IMPLEMENT) {
          // A plan the fan-out cannot run starts nothing, and the menu comes back if anyone is there.
          const unrunnable = yield* refusalOf(`implement-${round}`);
          if (unrunnable !== null) {
            if (nobodyAsked) return yield* new WorkflowError({ reason: unrunnable });
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
            input: !building
              ? { goal: asked.goal }
              : nobodyAsked
                ? // oxlint-disable-next-line unicorn/no-thenable -- implement's Input is named `then`
                  { plan: planDir, then: "finish" }
                : { plan: planDir },
            // What kind of result this is, and what it is called: settled during the
            // interview rather than asked for again at the start of the build.
            options: launch({
              task: building ? grilled.slug : "",
              outcome: building ? grilled.outcome : "",
              workspace: !building && rootingOf(place.options) !== "" ? "projects-root" : "",
            }),
          });
          yield* children.result(child);
          return `${written.issues_dir}: ${chosen} as ${child.runId}`;
        }

        if (chosen === OPINION) {
          opinions += 1;
          // A reviewer of its own, on its own agent: the planner that wrote the plan is
          // the last one who can tell you what is wrong with it.
          const said = yield* opinion(
            agentWork({
              operation: `second-opinion-${opinions}`,
              role: "reviewer",
              instructions: prompts.secondOpinion,
              input,
              output: ReviewOutputSchema,
            }),
            { round: opinions, of: OPINIONS },
          );
          // A second opinion with nothing to say is not a round of revision.
          if (said.findings.length === 0) continue;
          yield* revise(
            agentWork({
              ...planner,
              operation: `revise-${opinions}`,
              instructions: prompts.revise,
              input: { ...input, findings: formatFindings(said.findings) },
              output: Revised,
            }),
            { round: opinions, of: OPINIONS },
          );
          continue;
        }

        if (chosen === OFFLOAD) {
          yield* offload(
            Effect.gen(function* () {
              const board = yield* ask({
                name: "linear-team",
                prompt: "Which Linear team do new issues go to",
              });
              yield* agentWork({
                ...planner,
                operation: `offload-${round}`,
                instructions: prompts.offload,
                input: { ...input, config: { linear: { team: board } } },
                output: Offloaded,
              });
            }),
          );
          continue;
        }

        yield* refine(
          agentWork({
            ...planner,
            operation: `refine-${round}`,
            instructions: prompts.refine,
            input,
            output: Revised,
          }),
        );
      }
      return `${written.issues_dir}: asked ${ROUNDS} times what to do next`;
    }),
});
