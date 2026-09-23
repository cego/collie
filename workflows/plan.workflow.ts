// A goal, interviewed into a spec and tickets, and then the menu that decides what
// becomes of them.
//
// Three pieces of work on one planner, so its model is named once and the interview it
// held is still in the agent that writes the spec. Then a question, and another after
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
  WorkflowError,
  agentWork,
  ask,
  contentOf,
  decision,
  defineWorkflow,
  formatFindings,
  identityProblem,
  isSingleRepo,
  planReposOf,
  type WorkflowMetadata,
} from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import markdown from "./plan.md" with { type: "text" };

export const id = "plan";
export const title = "plan — turn a goal into a spec and tickets";
export const description =
  "Uses the goal and repository context to write a spec and tickets, asking only for missing decisions.";

export const input = {
  goal: Schema.String,
  ticket: Schema.optionalKey(Schema.String),
};

export const metadata: WorkflowMetadata = {
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
};

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

/** What the fan-out needs of a reading of the plan's `Repo:` and `Blocked by` lines. */
const Reading = Schema.Struct({
  single: Schema.Boolean,
  waves: Schema.Array(Schema.Array(Schema.String)),
  refusal: Schema.NullOr(Schema.String),
});

/** A second opinion is worth having twice at most; after that it is the same plan again. */
const OPINIONS = 2;

/** The planner is one agent for the whole run, so its model is named once, here. */
const PLANNER = "grill";

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const menu = Array.from({ length: ROUNDS }, (_, at) =>
    decision(`next-${at + 1}`, { prompt: "What next?", options: CHOICES }),
  );
  const team = decision("linear-team", {
    prompt: "Which Linear team do new issues go to",
  });

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* Host;
      const children = yield* Children;
      const runId = payload.runId;
      const asked = payload.input;
      const place = yield* host.place(runId);
      const inputs = { goal: asked.goal, ticket: asked.ticket ?? "" };
      const vars = { run: { dir: place.dir, id: runId } };
      const planDir = `${place.dir}/plan`;
      // Recorded, so a replay is handed the reading the plan was acted on.
      const readRepos = (at: string) =>
        Activity.make({
          name: `repos.${at}`,
          success: Reading,
          execute: planReposOf(planDir, place.cwd).pipe(
            Effect.map((plan) => ({
              single: isSingleRepo(plan),
              waves: plan.waves.map((wave) => [...wave]),
              refusal: plan.refusal?.message ?? null,
            })),
          ),
        });

      const grilled = yield* agentWork({
        runId,
        operation: "grill",
        agent: PLANNER,
        role: "planner",
        workflow: id,
        model: "fable",
        effort: "medium",
        cwd: place.cwd,
        instructions: prompt("grill"),
        inputs,
        vars,
        output: Grilled,
      });
      yield* agentWork({
        runId,
        operation: "spec",
        agent: PLANNER,
        role: "planner",
        skill: "to-spec",
        workflow: id,
        cwd: place.cwd,
        instructions: prompt("spec"),
        inputs,
        vars,
        output: Spec,
      });
      const written = yield* agentWork({
        runId,
        operation: "tickets",
        agent: PLANNER,
        role: "planner",
        skill: "to-tickets",
        workflow: id,
        cwd: place.cwd,
        instructions: prompt("tickets"),
        inputs,
        vars,
        output: PlanOutputSchema,
      });
      // A plan whose tickets nobody can build is not a finished plan: its planner is told once.
      const tickets = yield* readRepos("tickets");
      if (tickets.refusal !== null) {
        yield* agentWork({
          runId,
          operation: "unbuildable",
          agent: PLANNER,
          role: "planner",
          workflow: id,
          cwd: place.cwd,
          instructions: prompt("unbuildable"),
          inputs,
          vars: { ...vars, refusal: tickets.refusal },
          output: PlanOutputSchema,
        });
        const still = (yield* readRepos("unbuildable")).refusal;
        if (still !== null) return yield* new WorkflowError({ reason: still });
      }

      /**
       * One implement per repository the plan names, a wave at a time: a repository starts
       * once every one its tickets wait on is built. One that fails or cannot start starts
       * no further wave; the rest of its own wave is still waited on.
       */
      const buildEach = (waves: ReadonlyArray<ReadonlyArray<string>>) =>
        Effect.gen(function* () {
          const invocation = (repo: string) => `implement-${repo.replaceAll("/", "-")}`;
          const clash = identityProblem(waves.flat().map(invocation));
          if (clash !== null) return yield* new WorkflowError({ reason: clash });
          const built: string[] = [];
          for (const [at, wave] of waves.entries()) {
            const started = yield* Effect.forEach(wave, (repo) =>
              children
                .start({
                  runId,
                  invocation: invocation(repo),
                  workflow: "implement",
                  input: { plan: planDir },
                  // One branch name in every repository, so the sibling merge requests
                  // are findable by it.
                  options: launch({
                    repo,
                    workspace: `${place.cwd}/${repo}`,
                    task: grilled.slug,
                    outcome: grilled.outcome,
                  }),
                })
                .pipe(
                  Effect.result,
                  Effect.map((child) => ({ repo, child })),
                ),
            );
            const ended = yield* Effect.forEach(
              started,
              ({ repo, child }) =>
                child._tag === "Failure"
                  ? Effect.succeed({
                      repo,
                      built: null,
                      why: `not started: ${child.failure.reason}`,
                    })
                  : children.result(child.success).pipe(
                      Effect.map((value) => ({ repo, built: String(value), why: "" })),
                      Effect.catch((failure) =>
                        Effect.succeed({ repo, built: null, why: failure.reason }),
                      ),
                    ),
              { concurrency: "unbounded" },
            );
            for (const one of ended) {
              built.push(`${one.repo}: ${one.built ?? one.why}`);
              yield* host.record(runId, `${one.repo}: ${one.built ?? one.why}`);
            }
            const stopped = ended.find((one) => one.built === null);
            if (stopped !== undefined) {
              const left = waves.slice(at + 1).flat();
              const waiting =
                left.length === 0
                  ? ""
                  : ` Not run: ${left.join(", ")}, waiting on ${stopped.repo}.`;
              return `${stopped.repo} did not build.${waiting} ${built.join("; ")}`;
            }
          }
          return `${waves.flat().length} repositories built in ${waves.length} wave(s): ${built.join("; ")}`;
        });

      let opinions = 0;
      for (const [at, question] of menu.entries()) {
        const round = at + 1;
        // What is left to offer: an opinion already had twice is not offered a third time.
        const chosen = yield* ask(
          runId,
          question,
          opinions < OPINIONS ? CHOICES : CHOICES.filter((one) => one !== OPINION),
        );
        if (chosen === FINISH) return `${written.issues_dir}: finished planning`;

        if (chosen === IMPLEMENT) {
          // A plan the fan-out cannot run starts nothing, and the menu comes back.
          const plan = yield* readRepos(`implement-${round}`);
          if (plan.refusal !== null) {
            yield* host.record(runId, `${IMPLEMENT} cannot run here: ${plan.refusal}`);
            yield* host.parked(runId, `${IMPLEMENT} cannot run here: ${plan.refusal}`);
            continue;
          }
          yield* host.parked(runId, null);
          if (!plan.single) return `${written.issues_dir}: ${yield* buildEach(plan.waves)}`;
        }

        if (chosen === IMPLEMENT || chosen === ARCHITECTURE) {
          const building = chosen === IMPLEMENT;
          const child = yield* children.start({
            runId,
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
            runId,
            operation: `second-opinion-${opinions}`,
            role: "reviewer",
            workflow: id,
            model: "opus",
            effort: "xhigh",
            cwd: place.cwd,
            instructions: prompt("second-opinion"),
            inputs,
            vars,
            output: ReviewOutputSchema,
          });
          // A second opinion with nothing to say is not a round of revision.
          if (opinion.findings.length === 0) continue;
          yield* agentWork({
            runId,
            operation: `revise-${opinions}`,
            agent: PLANNER,
            role: "planner",
            workflow: id,
            cwd: place.cwd,
            instructions: prompt("revise"),
            inputs,
            vars: { ...vars, findings: formatFindings(opinion.findings) },
            output: Revised,
          });
          continue;
        }

        if (chosen === OFFLOAD) {
          const board = yield* ask(runId, team);
          yield* agentWork({
            runId,
            operation: `offload-${round}`,
            agent: PLANNER,
            role: "planner",
            workflow: id,
            cwd: place.cwd,
            instructions: prompt("offload"),
            inputs,
            vars: { ...vars, config: { linear: { team: board } } },
            output: Offloaded,
          });
          continue;
        }

        yield* agentWork({
          runId,
          operation: `refine-${round}`,
          agent: PLANNER,
          role: "planner",
          workflow: id,
          cwd: place.cwd,
          instructions: prompt("refine"),
          inputs,
          vars,
          output: Revised,
        });
      }
      return `${written.issues_dir}: asked ${ROUNDS} times what to do next`;
    }),
  );

  return {
    workflow,
    layer,
    decisions: Object.fromEntries([...menu, team].map((one) => [one.asks.name, one])),
  };
};
