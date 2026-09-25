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
import { loadEntry } from "../engine";
import { isWorkflowId } from "../sdk";
import { err } from "../operations";
import { attempt, mutation } from "../envelope";
import {
  UnknownJson,
  context,
  discoveryContext,
  forkFlags,
  mutating,
  requestIdFlag,
  root,
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
        const rows = modules.map((one) => `${one.id}\t${one.layer}\t${one.description}`).sort();
        return {
          ok: true,
          data: { workflows: modules, problems: saved.problems },
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

/** Where a drawing says less than the module does. The schema itself still holds. */
const limitLines = (one: Described): ReadonlyArray<string> =>
  one.success.limits.length + one.error.limits.length === 0
    ? []
    : [
        "The drawings above say less than the schemas do:",
        ...[...one.success.limits, ...one.error.limits].map((limit) => `  ${limit}`),
      ];

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
          const saved = yield* savedModules(resolved.env);
          const claimed = claimedIds(saved);
          const named = Option.isSome(workflow) ? workflow.value : null;
          if (named !== null && !claimed.has(named)) {
            return err("workflow_not_found", `Workflow "${named}" was not found.`);
          }
          // Each on its own: a module that will not load, will not construct or will not
          // typecheck says so without a Run, an agent or a worktree.
          const modules = yield* Effect.forEach(
            [...saved.entries, ...saved.problems].filter(
              (one) => named === null || one.id === named,
            ),
            (one) => checkModule({ layer: one.layer, path: one.path }),
          );
          const bad = modules.filter((item) => item.problems.length > 0).length;
          const report = [...modules.map(moduleReport), ...toolchainNotes(modules)]
            .filter((part) => part !== "")
            .join("\n");

          // The report goes in the message, not only in the details: a failing
          // envelope prints its message and nothing else for a human, and what is
          // wrong with which workflow is the whole reason to run this.
          return bad === 0
            ? { ok: true, data: { workflows: modules }, human: report }
            : err("operation_failed", `${bad} workflow(s) are not runnable.\n${report}`, {
                workflows: modules,
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
          return err("workflow_not_found", `Workflow "${workflow}" was not found.`);
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription("Show one Workflow: what it takes, what it gives back, where it is"),
);

/** Forking a module: a file that imports what it keeps. */
const forkModule = Effect.fn("Workflow.forkModule")(function* (
  env: PluginEnv,
  options: {
    readonly from: Found;
    readonly id: string;
    readonly layer: EntryLayer;
  },
) {
  const refused = notAnId(options.id);
  if (refused) return refused;
  const entry = yield* loadEntry(options.from.path).pipe(Effect.result);
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
  },
  ({ workflow, layer, name, requestId: request }) =>
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
                return yield* forkModule(base.env, { from: module, id: name, layer });
              }
              return err("workflow_not_found", `Workflow "${workflow}" was not found.`, {
                workflow,
              });
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "Write a Workflow of your own that imports another and replaces what it changes",
  ),
);

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
