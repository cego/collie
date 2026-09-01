import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { forkDefinition } from "../fork";
import { err } from "../operations";
import { attempt, mutation } from "../envelope";
import {
  context,
  definitions,
  discoveryContext,
  forkFlags,
  layerDir,
  personaData,
  root,
} from "./shared";

const personaList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* discoveryContext(global);
        if (resolved._tag === "ContextFailure") return resolved.result;
        const defs = yield* definitions(resolved.env);
        const personas = [...defs.personas.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(personaData);
        return {
          ok: true,
          data: { personas, errors: defs.errors },
          human:
            personas.map((item) => `${item.name}\t${item.description}`).join("\n") ||
            "No personas found.",
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("List every Persona and the Layer it came from"));

const personaShow = Command.make("show", { persona: Argument.string("persona") }, ({ persona }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* discoveryContext(global);
        if (resolved._tag === "ContextFailure") return resolved.result;
        const found = (yield* definitions(resolved.env)).personas.get(persona);
        return found
          ? {
              ok: true,
              data: { persona: personaData(found) },
              human: `${found.name}\n${found.description}\n\n${found.body}`,
            }
          : err("persona_not_found", `Persona "${persona}" was not found.`);
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("Show one Persona's instructions and where it is defined"));

const personaFork = Command.make(
  "fork",
  {
    persona: Argument.string("persona"),
    ...forkFlags,
  },
  ({ persona, layer, name, requestId: request }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const base = yield* context(global, false);
          if (base._tag === "ContextFailure") return base.result;
          return yield* mutation(base.env, "persona-fork", request, (_id) =>
            Effect.gen(function* () {
              // Resolved inside the mutation, so a replayed request id returns its
              // recorded result whether or not that workspace is still open.
              const resolved = yield* context(global, layer === "project", layer === "project");
              if (resolved._tag === "ContextFailure") return resolved.result;
              const found = (yield* definitions(resolved.env)).personas.get(persona);
              if (!found) return err("persona_not_found", `Persona "${persona}" was not found.`);
              const result = yield* forkDefinition(
                found.path,
                "personas",
                yield* layerDir(resolved.env, layer),
                {
                  name,
                  full: true,
                },
              );
              if (!result.ok) return err(result.code, result.message, { path: result.path });
              return {
                ok: true,
                data: { path: result.path, name, layer },
                human: `Forked ${persona} to ${result.path}.`,
              };
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Copy a Persona into your user or project Layer"));

export const persona = Command.make("persona").pipe(
  Command.withDescription("Inspect and fork Personas"),
  Command.withSubcommands([personaList, personaShow, personaFork]),
);
