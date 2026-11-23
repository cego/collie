import * as Arr from "effect/Array";
import { Effect, Option, Schema, flow, Result } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { checkModule, createEntry, forkEntry, readModule } from "../authoring";
import type { Checked as ModuleCheck, Described, Written } from "../authoring";
import { searchPath } from "../discovery";
import type { Catalogued, EntryLayer, Found } from "../discovery";
import type { PluginEnv } from "../env";
import { savedModules } from "../lifecycle";
import { loadEntry } from "../engine";
import { isWorkflowId } from "../sdk";
import { err } from "../operations";
import { attempt, mutation } from "../envelope";
import { tellHost } from "../tell-host";
import {
  UnknownJson,
  context,
  discoveryContext,
  forkFlags,
  mutating,
  requestIdFlag,
  root,
} from "./shared";

const workflowArg = Argument.String("workflow").pipe(
  Argument.withDescription("Which Workflow, as `workflow list` names it"),
);

const workflowList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* discoveryContext(global);
        if (resolved._tag === "ContextFailure") {
          return resolved.result;
        }
        const saved = yield* savedModules(resolved.env);
        const modules = yield* Effect.forEach(saved.entries, readModule);
        const rows = Arr.map(
          modules,
          (one) => `${one.id}\t${one.layer}\t${one.description}`,
        ).sort();
        return {
          ok: true,
          data: { workflows: modules, problems: saved.problems },
          human: Arr.join(rows, "\n") || "No workflows found.",
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("List every Workflow, with its Inputs and the Layer it came from"));

const claimedIds = (saved: Catalogued) =>
  new Set(Arr.map([...saved.entries, ...saved.problems], (one) => one.id));

const moduleDir = (env: PluginEnv, layer: EntryLayer) =>
  Option.getOrUndefined(
    Arr.findFirst(
      searchPath({ pluginRoot: env.pluginRoot, userDir: env.userDir, project: env.cwd }),
      (root) => root.layer === layer,
    ),
  )!.dir;

function describeForHuman(one: Described) {
  return Arr.join(
    [
      one.title,
      one.description,
      `Inputs: ${asJson(one.inputs)}`,
      "Host options — never this module's inputs, and always available:",
      ...Arr.map(one.options, (option) =>
        option.name === "branch" ? BRANCH_HELP : `  ${option.name}: ${option.meaning}`,
      ),
      `Result: ${asJson(one.success.schema)}`,
      `Failure: ${asJson(one.error.schema)}`,
      `Metadata: ${asJson(one.metadata)}`,
      ...limitLines(one),
      ...(one.broken === null ? [] : [`Will not construct: ${one.broken}`]),
      `Defined in: ${one.path} (${one.layer})`,
    ],
    "\n",
  );
}

const asJson = (value: Schema.Json) =>
  flow(Schema.encodeResult(UnknownJson), Result.getOrThrow)(value);

const limitLines = (one: Described) =>
  one.success.limits.length + one.error.limits.length === 0
    ? []
    : [
        "The drawings above say less than the schemas do:",
        ...Arr.map([...one.success.limits, ...one.error.limits], (limit) => `  ${limit}`),
      ];

const BRANCH_HELP = Arr.join(
  [
    "  branch: which branch this run works on, and so which checkout it gets.",
    "    `--input branch=<name>` wins; else the reviewed branch, for a run fixing a review;",
    "    else the `<name>` of a `branch:<base>...<name>` target you gave (never an inferred one).",
    "    Those are used as they came. Anything else is new work and gets a new",
    "    `<your GitLab login>/<task>`: from `--input task=<slug>`, else the plan directory's",
    "    own name, else a slug of the work itself. Nobody is ever asked for a branch — a name",
    "    too long, or with nothing in it, is cut to fit and given a digest of the work.",
  ],
  "\n",
);

function moduleReport(item: ModuleCheck) {
  return Arr.join(
    [
      `${item.id}\t${item.layer}\t${
        item.problems.length > 0
          ? `${item.problems.length} problem(s)`
          : item.toolchain === null
            ? "ok"
            : "ok, not typechecked"
      }`,
      ...Arr.map(item.problems, (problem) => `  ${problem}`),
      ...Arr.map(item.limits, (limit) => `  drawn without: ${limit}`),
    ],
    "\n",
  );
}

const toolchainNotes = (modules: ReadonlyArray<ModuleCheck>) =>
  Arr.map(
    [
      ...new Set(
        Arr.filter(
          Arr.map(modules, (item) => item.toolchain),
          (note) => note !== null,
        ),
      ),
    ],
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
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          const saved = yield* savedModules(resolved.env);
          const claimed = claimedIds(saved);
          const named = Option.isSome(workflow) ? workflow.value : null;
          if (named !== null && !claimed.has(named)) {
            return err("workflow_not_found", `Workflow "${named}" was not found.`);
          }
          const modules = yield* Effect.forEach(
            Arr.filter(
              [...saved.entries, ...saved.problems],
              (one) => named === null || one.id === named,
            ),
            (one) => checkModule({ layer: one.layer, path: one.path }),
            { concurrency: 4 },
          );
          // WARNING: the host re-reads each layer's revision only when told.
          yield* tellHost(resolved.env.stateDir, [
            ...new Set(Arr.map([...saved.entries, ...saved.problems], (one) => one.path)),
          ]);
          const bad = Arr.filter(modules, (item) => item.problems.length > 0).length;
          const report = Arr.join(
            Arr.filter(
              [...Arr.map(modules, moduleReport), ...toolchainNotes(modules)],
              (part) => part !== "",
            ),
            "\n",
          );

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
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          const saved = yield* savedModules(resolved.env);
          const module = Option.getOrUndefined(
            Arr.findFirst(saved.entries, (one) => one.id === workflow),
          );
          if (module) {
            const described = yield* readModule(module);
            return {
              ok: true,
              data: { workflow: described },
              human: describeForHuman(described),
            };
          }
          const broken = Option.getOrUndefined(
            Arr.findFirst(saved.problems, (one) => one.id === workflow),
          );
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

const forkModule = Effect.fn("Workflow.forkModule")(function* (
  env: PluginEnv,
  options: {
    readonly from: Found;
    readonly id: string;
    readonly layer: EntryLayer;
  },
) {
  const refused = notAnId(options.id);
  if (refused) {
    return refused;
  }
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

const notAnId = (id: string) =>
  isWorkflowId(id)
    ? null
    : err("invalid_input", `"${id}" is not a workflow id: lower case, digits and dashes.`);

const asWritten = (written: Written, did: string) => {
  if (!written.ok) {
    return err("target_exists", written.message, { path: written.path });
  }
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
        if (refused) {
          return refused;
        }
        const written = yield* createEntry({ dir: moduleDir(env, layer), id: workflow });
        if (written.ok) {
          yield* tellHost(env.stateDir, [written.path]);
        }
        return asWritten(written, "Wrote");
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
          if (base._tag === "ContextFailure") {
            return base.result;
          }
          return yield* mutation(base.env, "workflow-fork", request, (_id) =>
            Effect.gen(function* () {
              const module = Option.getOrUndefined(
                Arr.findFirst(
                  (yield* savedModules(base.env)).entries,
                  (one) => one.id === workflow,
                ),
              );
              if (module) {
                const forked = yield* forkModule(base.env, { from: module, id: name, layer });
                yield* tellHost(base.env.stateDir, [moduleDir(base.env, layer)]);
                return forked;
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
