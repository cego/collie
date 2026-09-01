import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { bodySections } from "../definitions";
import { forkDefinition } from "../fork";
import { unsafePathComponent } from "../naming";
import { err } from "../operations";
import { attempt, mutation } from "../envelope";
import {
  UnknownJson,
  context,
  definitions,
  discoveryContext,
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
        if ("ok" in resolved) return resolved;
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
          if ("ok" in resolved) return resolved;
          const wf = (yield* definitions(resolved.env)).workflows.get(workflow);
          return wf
            ? {
                ok: true,
                data: { workflow: workflowData(wf) },
                human: `${wf.title}\n${wf.description}\nInputs: ${Schema.encodeSync(UnknownJson)(wf.inputs)}`,
              }
            : err("workflow_not_found", `Workflow "${workflow}" was not found.`);
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Show one Workflow: its Steps, its Inputs and where it is defined"));

const forkFlags = {
  layer: Flag.choice("layer", ["user", "project"]),
  name: Flag.string("name"),
  requestId: Flag.string("request-id").pipe(Flag.optional),
};

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
          if ("ok" in base) return base;
          return yield* mutation(base.env, "workflow-fork", request, (id) =>
            Effect.gen(function* () {
              void id;
              // The workspace a project-layer fork needs is resolved inside the
              // mutation, so replaying a receipt returns the recorded result rather
              // than needing that workspace to still be open.
              const resolved = yield* context(global, layer === "project", layer === "project");
              if ("ok" in resolved) return resolved;
              const wf = (yield* definitions(resolved.env)).workflows.get(workflow);
              if (!wf) return err("workflow_not_found", `Workflow "${workflow}" was not found.`);
              if (unsafePathComponent(name))
                return err("invalid_input", `"${name}" is not a valid Workflow name.`);
              const pathSvc = yield* Path.Path;
              const fs = yield* FileSystem.FileSystem;
              const target = pathSvc.join(
                yield* layerDir(resolved.env, layer),
                "workflows",
                `${name}.md`,
              );
              if (yield* fs.exists(target))
                return err("target_exists", `${target} already exists.`, { path: target });
              const pickedStep = Option.isSome(step) ? step.value : undefined;
              if (pickedStep && !wf.steps.some((item) => item.id === pickedStep)) {
                return err("invalid_input", `Workflow "${workflow}" has no Step "${pickedStep}".`);
              }
              const result = yield* forkDefinition(
                wf.path,
                "workflows",
                yield* layerDir(resolved.env, layer),
                {
                  name,
                  full: mode === "copy",
                  step: pickedStep,
                  section: pickedStep ? bodySections(wf.body).sections.get(pickedStep) : undefined,
                },
              );
              if (!result.ok) return err("target_exists", result.message, { path: result.path });
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
