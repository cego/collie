import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { forkResolvedDefinition } from "../fork";
import { loadDefaults } from "../config";
import {
  resolveWorkflow,
  skillDirs,
  validateWorkflow,
  type ResolvedWorkflow,
} from "../definitions";
import { CHAIN_SUPPLIED, ENGINE_SUPPLIED } from "../engine";
import { KINDED_STRATEGIES } from "../inputs";
import { reason } from "../naming";
import { branchListed, mutates, roams } from "../worktree";
import { renderTemplate } from "../template";
import { err } from "../operations";
import { attempt, mutation } from "../envelope";
import {
  UnknownJson,
  context,
  definitions,
  discoveryContext,
  forkFlags,
  layerDir,
  root,
  workflowData,
} from "./shared";

/** The Workflow a `workflow` subcommand acts on. */
const workflowArg = Argument.String("workflow").pipe(
  Argument.withDescription("Which Workflow, as `workflow list` names it"),
);

const workflowList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* discoveryContext(global);
        if (resolved._tag === "ContextFailure") return resolved.result;
        const defs = yield* definitions(resolved.env);
        const workflows = [...defs.workflows.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(workflowData);
        return {
          ok: true,
          data: { workflows, errors: defs.errors },
          human:
            workflows.map((item) => `${item.name}\t${item.description}`).join("\n") ||
            "No workflows found.",
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("List every Workflow, with its Inputs and the Layer it came from"));

/**
 * Placeholders this workflow can never resolve. The engine already reports these —
 * into the run log, after the Run has started; rendering each step against the
 * workflow's own declared inputs says it before anyone waits for an agent.
 */
function unresolvable(wf: ResolvedWorkflow): string[] {
  const inputs: Record<string, string> = {};
  for (const [name, strategy] of Object.entries(wf.inputs)) {
    inputs[name] = "";
    // Only the strategies that carry a kind render a `<name>_kind` companion; adding
    // one for every Input would pass a placeholder the Run then renders empty.
    if (KINDED_STRATEGIES.has(strategy)) inputs[`${name}_kind`] = "";
  }
  const problems: string[] = [];
  const stepIds = new Set(wf.steps.map((step) => step.id));
  for (const step of wf.steps) {
    // A body, where it is, and which engine-supplied families reach it: a step's
    // prompt is rendered with all of them, a forwarded Choice input with two.
    const bodies: Array<[string, string, ReadonlySet<string>]> = [
      [`step "${step.id}"`, `${step.preamble}\n${step.prompt}`, ENGINE_SUPPLIED],
    ];
    for (const choice of step.choices ?? []) {
      for (const round of [choice.round, choice.followUp]) {
        if (round) {
          bodies.push([
            `step "${step.id}" choice "${choice.title}"`,
            round.prompt,
            ENGINE_SUPPLIED,
          ]);
        }
      }
      // What a Choice forwards to the workflow it chains is rendered from the same
      // variables. A typo there renders empty, is forwarded as a settled value, and
      // starts the child without the Input it needed — silently.
      for (const [name, value] of Object.entries(choice.inputs ?? {})) {
        bodies.push([
          `step "${step.id}" choice "${choice.title}" input "${name}"`,
          value,
          CHAIN_SUPPLIED,
        ]);
      }
    }
    for (const [where, body, supplied] of bodies) {
      for (const key of renderTemplate(body, { inputs }).missing) {
        const [family = key, step = ""] = key.split(".");
        // An Output is named by the step that writes it, so a mistyped step id is a
        // supplied family too — reported here rather than rendered empty.
        if (family === "outputs" && supplied.has(family)) {
          if (!stepIds.has(step)) problems.push(`${where}: {{${key}}} names no step here`);
          continue;
        }
        if (supplied.has(family)) continue;
        problems.push(`${where}: {{${key}}} is not an input this workflow takes`);
      }
    }
  }
  return problems;
}

/**
 * What `branch` is, wherever a mutating Workflow's Inputs are listed. Its resolution
 * order rather than a definition, because the order is the whole of it: an operator
 * reading this needs to know when their `--input branch=` is the one that decides.
 */
const BRANCH_HELP = [
  "  branch: which branch this run works on, and so which checkout it gets.",
  "    `--input branch=<name>` wins; else the reviewed branch, for a run fixing a review;",
  "    else the `<name>` of a `branch:<base>...<name>` target you gave (never an inferred one).",
  "    Those are used as they came. Anything else is new work and gets a new",
  "    `<your GitLab login>/<task>`: from `--input task=<slug>`, else the plan directory's",
  "    own name, else a slug of the work itself. Nobody is ever asked for a branch — a name",
  "    too long, or with nothing in it, is cut to fit and given a digest of the work.",
].join("\n");

/** One workflow as `check` reports it, and what it is wrong about, one per line. */
type Checked = { name: string; layer: string; problems: string[] };

function checkReport(checked: Checked[], errors: ReadonlyArray<string>): string {
  const lines = checked.map((item) =>
    [
      `${item.name}\t${item.layer}\t${item.problems.length === 0 ? "ok" : `${item.problems.length} problem(s)`}`,
      ...item.problems.map((problem) => `  ${problem}`),
    ].join("\n"),
  );
  return [...lines, ...errors.map((error) => `  ${error}`)].join("\n");
}

/**
 * Whether a load error is about this workflow's own file. A definition that would not
 * parse is skipped by `loadDefinitions` and shows up only here and in the picker's
 * banner — and it has no name to match on, because its name is what failed to parse.
 * The file name is what attributes it, which is what tells an author who broke a
 * higher layer's `review.md` that `review` is not fine, however well the layer below
 * checks out.
 */
function brokeFile(workflow: string): (error: string) => boolean {
  return (error) => error.split(":")[0]?.endsWith(`/${workflow}.md`) === true;
}

const workflowCheck = Command.make(
  "check",
  {
    workflow: Argument.String("workflow").pipe(
      Argument.withDescription("Check only this Workflow; omit it to check every one"),
      Argument.optional,
    ),
  },
  ({ workflow }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* discoveryContext(global);
          if (resolved._tag === "ContextFailure") return resolved.result;
          const defs = yield* definitions(resolved.env);
          const defaults = yield* loadDefaults(resolved.env.configDir);
          const dirs = yield* skillDirs(resolved.env);
          if (Option.isSome(workflow) && !defs.workflows.has(workflow.value)) {
            return err("workflow_not_found", `Workflow "${workflow.value}" was not found.`);
          }
          const names = Option.isSome(workflow) ? [workflow.value] : [...defs.workflows.keys()];

          const checked: Checked[] = [];
          for (const name of names.sort()) {
            const def = defs.workflows.get(name)!;
            // A workflow that will not resolve — a cycle, an embedded workflow that is
            // not there — has that as its one problem, and the rest are still checked.
            const wf = yield* Effect.try(() => resolveWorkflow(name, defs, defaults)).pipe(
              Effect.catch((cause) => Effect.succeed({ failed: reason(cause) })),
            );
            const problems =
              "failed" in wf
                ? [wf.failed]
                : [...(yield* validateWorkflow(wf, defs, defaults, dirs)), ...unresolvable(wf)];
            checked.push({ name, layer: def.layer, problems });
          }

          const errors = Option.isSome(workflow)
            ? defs.errors.filter(brokeFile(workflow.value))
            : defs.errors;
          const bad = checked.filter((item) => item.problems.length > 0).length + errors.length;
          const report = checkReport(checked, errors);

          // The report goes in the message, not only in the details: a failing
          // envelope prints its message and nothing else for a human, and what is
          // wrong with which workflow is the whole reason to run this.
          return bad === 0
            ? { ok: true, data: { workflows: checked, errors }, human: report }
            : err("operation_failed", `${bad} workflow(s) are not runnable.\n${report}`, {
                workflows: checked,
                errors,
              });
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Validate Workflows in every Layer, without starting a Run"));

const workflowShow = Command.make(
  "show",
  {
    workflow: workflowArg,
  },
  ({ workflow }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* discoveryContext(global);
          if (resolved._tag === "ContextFailure") return resolved.result;
          const defs = yield* definitions(resolved.env);
          if (!defs.workflows.has(workflow)) {
            return err("workflow_not_found", `Workflow "${workflow}" was not found.`);
          }
          // Resolved, not as authored: a Run takes an embedded workflow's inputs and
          // runs its expanded steps, and `show` is the command you check that with.
          const defaults = yield* loadDefaults(resolved.env.configDir);
          const wf = resolveWorkflow(workflow, defs, defaults);
          const inherited = new Set(wf.embeddedInputs);
          const inputs = branchListed(wf.checkout, wf.inputs);
          return {
            ok: true,
            data: {
              workflow: {
                name: wf.name,
                title: wf.title,
                description: wf.description,
                inputs,
                inherited: wf.embeddedInputs,
                steps: wf.steps.map((step) => step.id),
                layer: wf.layer,
                path: wf.path,
              },
            },
            human: [
              wf.title,
              wf.description,
              `Inputs: ${Schema.encodeSync(UnknownJson)(inputs)}`,
              ...(mutates(wf.checkout) && !roams(wf.checkout) ? [BRANCH_HELP] : []),
              ...(wf.embeddedInputs.length > 0
                ? [`Inherited from an embedded workflow: ${[...inherited].join(", ")}`]
                : []),
              "Steps:",
              // A Choice step's titles are what `run start --decide` takes.
              ...wf.steps.map((step) => {
                const titles = [...new Set((step.choices ?? []).map((c) => c.title))];
                return titles.length > 0
                  ? `  ${step.id} — decide one of: ${titles.join(", ")}`
                  : `  ${step.id}`;
              }),
              `Defined in: ${wf.path}`,
            ].join("\n"),
          };
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Show one Workflow: its Steps, its Inputs and where it is defined"));

const workflowFork = Command.make(
  "fork",
  {
    workflow: workflowArg,
    ...forkFlags,
    mode: Flag.Literals("mode", ["extends", "copy"]).pipe(
      Flag.withDescription(
        "`extends` changes only what the fork names; `copy` takes the whole definition",
      ),
    ),
    step: Flag.String("step").pipe(
      Flag.withDescription("Fork only this Step, leaving the rest following the parent"),
      Flag.optional,
    ),
  },
  ({ workflow, layer, mode, name, requestId: request, step }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const base = yield* context(global, false);
          if (base._tag === "ContextFailure") return base.result;
          return yield* mutation(base.env, "workflow-fork", request, (_id) =>
            Effect.gen(function* () {
              // The workspace a project-layer fork needs is resolved inside the
              // mutation, so replaying a receipt returns the recorded result rather
              // than needing that workspace to still be open.
              const resolved = yield* context(global, layer === "project", layer === "project");
              if (resolved._tag === "ContextFailure") return resolved.result;
              const wf = (yield* definitions(resolved.env)).workflows.get(workflow);
              if (!wf) return err("workflow_not_found", `Workflow "${workflow}" was not found.`);
              const pickedStep = Option.isSome(step) ? step.value : undefined;
              const result = yield* forkResolvedDefinition(
                {
                  path: wf.path,
                  kind: "workflows",
                  steps: wf.steps.map((item) => item.id),
                  body: wf.body,
                },
                yield* layerDir(resolved.env, layer),
                {
                  name,
                  full: mode === "copy",
                  step: pickedStep,
                },
              );
              if (!result.ok)
                return err(
                  result.code,
                  result.code === "invalid_input"
                    ? `Workflow "${workflow}" has no Step "${pickedStep}".`
                    : result.message,
                  result.path ? { path: result.path } : undefined,
                );
              return {
                ok: true,
                data: { path: result.path, name, layer, mode },
                human: `Forked ${workflow} to ${result.path}.`,
              };
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Copy or extend a Workflow into your user or project Layer"));

export const workflow = Command.make("workflow").pipe(
  Command.withDescription("Inspect and fork Workflows"),
  Command.withSubcommands([workflowList, workflowShow, workflowCheck, workflowFork]),
);
