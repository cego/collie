import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { forkResolvedDefinition } from "../fork";
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

const workflowShow = Command.make(
  "show",
  { workflow: Argument.string("workflow") },
  ({ workflow }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* discoveryContext(global);
          if (resolved._tag === "ContextFailure") return resolved.result;
          const wf = (yield* definitions(resolved.env)).workflows.get(workflow);
          return wf
            ? {
                ok: true,
                data: { workflow: workflowData(wf) },
                human: [
                  wf.title,
                  wf.description,
                  `Inputs: ${Schema.encodeSync(UnknownJson)(wf.inputs)}`,
                  "Steps:",
                  ...wf.steps.map((step) => `  ${step.id}`),
                  `Defined in: ${wf.path}`,
                ].join("\n"),
              }
            : err("workflow_not_found", `Workflow "${workflow}" was not found.`);
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Show one Workflow: its Steps, its Inputs and where it is defined"));

const workflowFork = Command.make(
  "fork",
  {
    workflow: Argument.string("workflow"),
    ...forkFlags,
    mode: Flag.choice("mode", ["extends", "copy"]),
    step: Flag.string("step").pipe(Flag.optional),
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
  Command.withSubcommands([workflowList, workflowShow, workflowFork]),
);
