// A plan that spans repositories, one child Run per repository, in waves.
//
// The waves are `readPlanRepos`' own: a repository starts when the ones its tickets are
// blocked by have finished. Everything else is Effect — `Effect.forEach` over a wave,
// concurrent because nothing in a wave waits for anything else in it.
//
// A plan that cannot be fanned out at all is refused here, where no child exists yet.

import {
  WorkflowError,
  child,
  defineWorkflow,
  isSingleRepo,
  planReposOf,
  type WorkflowMetadata,
} from "collie";
import { Effect, Schema } from "effect";

export const id = "spread";
export const title = "Build a plan that spans repositories";
export const description = "One Run per repository the plan names, in the order it allows.";

export const input = {
  plan: Schema.String,
  /** Where the checkouts are: a repository with none of its own is not somewhere to work. */
  root: Schema.String,
};

export const metadata: WorkflowMetadata = {
  hints: { plan: "work-source" },
  outcome: { fixed: "feature" },
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const { runId, input: asked } = payload;
      const plan = yield* planReposOf(asked.plan, asked.root);
      if (plan.refusal !== null) {
        return yield* new WorkflowError({
          reason: `${plan.refusal.kind}: ${plan.refusal.message}`,
        });
      }
      if (isSingleRepo(plan)) return "one repository: nothing to fan out";

      const share = (repo: string) => plan.repos.find((one) => one.path === repo)?.tickets ?? [];
      const built: string[] = [];
      for (const wave of plan.waves) {
        const done = yield* Effect.forEach(
          wave,
          (repo) =>
            child({
              runId,
              // The repository is the invocation: replaying the parent comes back to the
              // Run it already started for it rather than starting a second one.
              invocation: `repo-${repo}`,
              workflow: "share",
              input: { plan: asked.plan, tickets: [...share(repo)] },
              // The host's own options, as a front door supplies them: which repository
              // this Run is for, and the checkout it works in.
              options: { repo, workspace: `${asked.root}/${repo}` },
            }).pipe(Effect.map((value) => `${repo}(${String(value)})`)),
          { concurrency: "unbounded" },
        );
        built.push(done.join(" "));
      }
      return built.join(" then ");
    }),
  );

  return { workflow, layer, decisions: {} };
};
