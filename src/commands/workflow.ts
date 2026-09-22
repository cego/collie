import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  checkModule,
  createEntry,
  forkEntry,
  readModule,
  type Checked as ModuleCheck,
  type Described,
  type Written,
} from "../authoring";
import { searchPath, type Catalogued, type EntryLayer, type Found } from "../discovery";
import type { PluginEnv } from "../env";
import { savedModules } from "../lifecycle";
import { loadEntry } from "../native";
import { isWorkflowId } from "../sdk";
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
  mutating,
  requestIdFlag,
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
        const saved = yield* savedModules(resolved.env);
        const modules = yield* Effect.forEach(saved.entries, readModule);
        const defs = yield* definitions(resolved.env);
        // A definition whose id a module claims is not what that id runs, so it is not
        // listed as if it were — the same rule a launch decides by.
        const claimed = claimedIds(saved);
        const workflows = [...defs.workflows.values()]
          .filter((wf) => !claimed.has(wf.name))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(workflowData);
        const rows = [
          ...modules.map((one) => `${one.id}\t${one.layer}\t${one.description}`),
          ...workflows.map((item) => `${item.name}\t${item.layer}\t${item.description}`),
        ].sort();
        return {
          ok: true,
          data: { workflows, modules, errors: defs.errors, problems: saved.problems },
          human: rows.join("\n") || "No workflows found.",
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("List every Workflow, with its Inputs and the Layer it came from"));

/** Every id a saved module answers for, whether it loaded or refused its own file. */
const claimedIds = (saved: Catalogued): ReadonlySet<string> =>
  new Set([...saved.entries, ...saved.problems].map((one) => one.id));

/** Where the modules an author writes are saved, by Layer. */
const moduleDir = (env: PluginEnv, layer: EntryLayer): string =>
  searchPath({ pluginRoot: env.pluginRoot, project: env.cwd }).find((root) => root.layer === layer)!
    .dir;

/** One module as a human reads it: what it takes, what it gives back, and where it is. */
function describeForHuman(one: Described): string {
  return [
    one.title,
    one.description,
    `Inputs: ${asJson(one.inputs)}`,
    "Host options — never this module's inputs, and always available:",
    ...one.options.map((option) =>
      // `branch` decides which checkout the run gets, so its resolution order is the
      // whole of what an operator needs; the rest are one sentence each.
      option.name === "branch" ? BRANCH_HELP : `  ${option.name}: ${option.meaning}`,
    ),
    `Result: ${asJson(one.success.schema)}`,
    `Failure: ${asJson(one.error.schema)}`,
    `Metadata: ${asJson(one.metadata)}`,
    ...limitLines(one),
    ...(one.broken === null ? [] : [`Will not construct: ${one.broken}`]),
    `Defined in: ${one.path} (${one.layer})`,
  ].join("\n");
}

const asJson = (value: Schema.Json) => Schema.encodeSync(UnknownJson)(value);

/** Where a drawing says less than the module does. The native schema still holds. */
const limitLines = (one: Described): ReadonlyArray<string> =>
  one.success.limits.length + one.error.limits.length === 0
    ? []
    : [
        "The drawings above say less than the schemas do:",
        ...[...one.success.limits, ...one.error.limits].map((limit) => `  ${limit}`),
      ];

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
 * One module as `check` reports it. Not typechecked is said out loud: silence there
 * would read as a module the compiler was happy with, and nothing compiled it.
 */
function moduleReport(item: ModuleCheck): string {
  return [
    `${item.id}\t${item.layer}\t${
      item.problems.length > 0
        ? `${item.problems.length} problem(s)`
        : item.toolchain === null
          ? "ok"
          : "ok, not typechecked"
    }`,
    ...item.problems.map((problem) => `  ${problem}`),
    ...item.limits.map((limit) => `  drawn without: ${limit}`),
  ].join("\n");
}

/** Why nothing in a directory was typechecked, once per directory rather than per module. */
const toolchainNotes = (modules: ReadonlyArray<ModuleCheck>): ReadonlyArray<string> =>
  [...new Set(modules.map((item) => item.toolchain).filter((note) => note !== null))].map(
    (note) => `not typechecked: ${note}`,
  );

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
          const saved = yield* savedModules(resolved.env);
          const claimed = claimedIds(saved);
          const named = Option.isSome(workflow) ? workflow.value : null;
          if (named !== null && !claimed.has(named) && !defs.workflows.has(named)) {
            return err("workflow_not_found", `Workflow "${named}" was not found.`);
          }
          // Modules first, and each on its own: a module that will not load, will not
          // construct or will not typecheck says so without a Run, an agent or a worktree.
          const modules = yield* Effect.forEach(
            [...saved.entries, ...saved.problems].filter(
              (one) => named === null || one.id === named,
            ),
            (one) => checkModule({ layer: one.layer, path: one.path }),
          );
          const names = (named !== null ? [named] : [...defs.workflows.keys()]).filter(
            (name) => !claimed.has(name),
          );

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

          const errors = named !== null ? defs.errors.filter(brokeFile(named)) : defs.errors;
          const bad =
            checked.filter((item) => item.problems.length > 0).length +
            modules.filter((item) => item.problems.length > 0).length +
            errors.length;
          const report = [
            ...modules.map(moduleReport),
            checkReport(checked, errors),
            ...toolchainNotes(modules),
          ]
            .filter((part) => part !== "")
            .join("\n");

          // The report goes in the message, not only in the details: a failing
          // envelope prints its message and nothing else for a human, and what is
          // wrong with which workflow is the whole reason to run this.
          return bad === 0
            ? { ok: true, data: { workflows: checked, modules, errors }, human: report }
            : err("operation_failed", `${bad} workflow(s) are not runnable.\n${report}`, {
                workflows: checked,
                modules,
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
          // What this id runs, which is the module where one is saved for it. A broken
          // override is a file to fix, never a fall-through to the definition below it.
          const saved = yield* savedModules(resolved.env);
          const module = saved.entries.find((one) => one.id === workflow);
          if (module) {
            const described = yield* readModule(module);
            return {
              ok: true,
              data: { workflow: described },
              human: describeForHuman(described),
            };
          }
          const broken = saved.problems.find((one) => one.id === workflow);
          if (broken) {
            return err("operation_failed", `${broken.path}: ${broken.message}`, {
              workflow,
              path: broken.path,
            });
          }
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

/**
 * Forking a module: a file that imports what it keeps. There is nothing to merge, so the
 * flags that named a step to merge are refused with what to do instead rather than given
 * an adapter — the Markdown engine's step merge has no counterpart in ordinary code.
 */
const forkModule = Effect.fn("Workflow.forkModule")(function* (
  env: PluginEnv,
  options: {
    readonly from: Found;
    readonly id: string;
    readonly layer: EntryLayer;
    readonly merging: ReadonlyArray<string>;
  },
) {
  if (options.merging.length > 0) {
    return err(
      "invalid_input",
      `"${options.from.id}" is saved as a module, and ${options.merging.join(" and ")} merged Markdown steps. ` +
        "Fork it — the fork imports everything it does not name — then change what you came to change.",
    );
  }
  const refused = notAnId(options.id);
  if (refused) return refused;
  const entry = yield* loadEntry(options.from.path, options.from.revision).pipe(Effect.result);
  if (entry._tag === "Failure") {
    return err("operation_failed", `${options.from.path}: ${entry.failure.message}`);
  }
  const written = yield* forkEntry({
    dir: moduleDir(env, options.layer),
    id: options.id,
    from: { path: options.from.path, entry: entry.success },
  });
  return asWritten(written, `Forked ${options.from.id} to`);
});

/** Why this is not a name a module may claim, or null. A file is written only for a name. */
const notAnId = (id: string) =>
  isWorkflowId(id)
    ? null
    : err("invalid_input", `"${id}" is not a workflow id: lower case, digits and dashes.`);

/** What writing a module came to, as one envelope: the path, and any toolchain it lacks. */
const asWritten = (written: Written, did: string) => {
  if (!written.ok) return err("target_exists", written.message, { path: written.path });
  const note =
    written.toolchain === null
      ? ""
      : `\n${written.toolchain} — the module still runs; \`collie workflow check\` will say this too.`;
  return {
    ok: true as const,
    data: { path: written.path, toolchain: written.toolchain },
    human: `${did} ${written.path}.${note}`,
  };
};

const workflowCreate = Command.make(
  "create",
  {
    workflow: Argument.String("workflow").pipe(
      Argument.withDescription("The public id the new Workflow answers to"),
    ),
    layer: Flag.Literals("layer", ["user", "project"]).pipe(
      Flag.withDescription("Where to save it: your own workflows, or this project's"),
      Flag.withDefault("user" as const),
    ),
    requestId: requestIdFlag,
  },
  ({ workflow, layer, requestId: request }) =>
    mutating("workflow-create", request, (env) =>
      Effect.gen(function* () {
        const refused = notAnId(workflow);
        if (refused) return refused;
        return asWritten(yield* createEntry({ dir: moduleDir(env, layer), id: workflow }), "Wrote");
      }),
    ),
).pipe(
  Command.withDescription("Write a new Workflow module where a Run will find it"),
  Command.withExamples([
    {
      command: "collie workflow create tally",
      description: "A runnable module in your own layer, with the toolchain to typecheck it",
    },
  ]),
);

const workflowFork = Command.make(
  "fork",
  {
    workflow: workflowArg,
    ...forkFlags,
    mode: Flag.Literals("mode", ["extends", "copy"]).pipe(
      Flag.withDescription(
        "`extends` changes only what the fork names; `copy` takes the whole definition",
      ),
      Flag.optional,
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
              // A module is saved beside the project rather than in a Layer a workspace
              // resolves, so forking one asks for no workspace at all.
              const module = (yield* savedModules(base.env)).entries.find(
                (one) => one.id === workflow,
              );
              if (module) {
                return yield* forkModule(base.env, {
                  from: module,
                  id: name,
                  layer,
                  merging: [
                    ...(Option.isSome(mode) ? ["--mode"] : []),
                    ...(Option.isSome(step) ? ["--step"] : []),
                  ],
                });
              }
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
                  full: Option.isSome(mode) && mode.value === "copy",
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
                data: {
                  path: result.path,
                  name,
                  layer,
                  mode: Option.getOrElse(mode, () => "extends"),
                },
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
  Command.withDescription("Write, inspect and fork Workflows"),
  Command.withSubcommands([
    workflowList,
    workflowShow,
    workflowCheck,
    workflowCreate,
    workflowFork,
  ]),
);
