// What a front door is told a Machine's Workflows and Personas are, in one read of its host.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { PROTOCOL } from "../src/board-model";
import { connect, frontDoor, socketOf } from "../src/host";
import { root } from "./support/host";
import { collie, proves } from "./support/world";

const SHIPPED = [
  "architecture",
  "general",
  "implement",
  "investigate",
  "plan",
  "release",
  "renovate",
  "review",
  "self-improve",
  "stage",
];

/** Overrides the shipped general, so the user Layer's claim is the one read. */
const OVERRIDE = `import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "general",
  title: "My general",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  run: () => Effect.void,
});
`;

/** Loads, but its failure schema cannot be built, so `make` throws. */
const UNBUILT = `import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

const unbuilt = Object.create(Schema.String, {
  ast: {
    get() {
      throw new Error("this failure schema cannot be built");
    },
  },
});

export default defineWorkflow({
  id: "unbuilt",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  error: unbuilt,
  run: () => Effect.void,
});
`;

/** Names a template value, which a Persona may not. */
const UNLOADABLE = `---
name: unloadable
description: Asks for what it is never told
---

Work on {{goal}}.
`;

const PERSONA = `---
name: mine
description: A Persona of my own
---

Do it my way.
`;

test(
  "a host reads its shipped and user Workflows and Personas in full, without a toolchain",
  () =>
    proves(
      "collie-host-definitions-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.copy(`${root}workflows`, `${world.install}/workflows`);
          yield* fs.copy(`${root}personas`, `${world.install}/personas`);
          yield* fs.writeFileString(`${world.user}/general.workflow.ts`, OVERRIDE);
          yield* fs.writeFileString(`${world.user}/general.md`, "My prompt.\n");
          yield* fs.writeFileString(`${world.user}/unbuilt.workflow.ts`, UNBUILT);
          yield* fs.writeFileString(`${world.user}/garbled.workflow.ts`, "export default 1;\n");
          yield* fs.makeDirectory(`${world.config}/personas`);
          yield* fs.writeFileString(`${world.config}/personas/mine.md`, PERSONA);
          yield* fs.writeFileString(`${world.config}/personas/unloadable.md`, UNLOADABLE);

          yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          const read = yield* door.definitions();

          const byId = new Map(read.workflows.map((one) => [one.id, one]));
          expect(read.workflows.map((one) => one.id).sort()).toEqual(
            [...SHIPPED, "unbuilt"].sort(),
          );
          for (const id of SHIPPED.filter((one) => one !== "general")) {
            expect(byId.get(id)).toMatchObject({ layer: "shipped", broken: null });
            expect(byId.get(id)?.inputs.length).toBeGreaterThan(0);
            expect(byId.get(id)?.metadata).toMatchObject({ hints: expect.any(Object) });
          }
          const shippedDir = `${world.install}/workflows`;
          const named = (id: string) => byId.get(id)?.files.map((file) => file.path);
          expect(named("plan")).toEqual([
            `${shippedDir}/plan.md`,
            `${shippedDir}/plan.workflow.ts`,
          ]);
          expect(named("renovate")).toEqual([
            `${shippedDir}/renovate.github.md`,
            `${shippedDir}/renovate.gitlab.md`,
            `${shippedDir}/renovate.workflow.ts`,
          ]);
          expect(named("review")).toEqual([
            `${shippedDir}/review.md`,
            `${shippedDir}/review.workflow.ts`,
          ]);
          expect(read.workflows.flatMap((one) => one.files).map((file) => file.path)).not.toContain(
            `${shippedDir}/reviewing.ts`,
          );
          const implement = byId.get("implement")?.files[0];
          expect(implement?.text).toBe(yield* fs.readFileString(`${root}workflows/implement.md`));

          // The user Layer's general is the one read, once, with its own files.
          expect(byId.get("general")).toMatchObject({
            layer: "user",
            title: "My general",
            broken: null,
          });
          expect(named("general")).toEqual([
            `${world.user}/general.md`,
            `${world.user}/general.workflow.ts`,
          ]);
          expect(byId.get("general")?.files[0]?.text).toBe("My prompt.\n");

          expect(byId.get("unbuilt")?.broken).toBe("this failure schema cannot be built");
          expect(read.problems).toEqual([
            expect.objectContaining({ id: "garbled", layer: "user", message: expect.any(String) }),
          ]);

          const personas = new Map(read.personas.map((one) => [one.name, one]));
          const shippedPersonas = (yield* fs.readDirectory(`${root}personas`)).filter((name) =>
            name.endsWith(".md"),
          );
          expect(read.personas.length).toBe(shippedPersonas.length + 1);
          for (const persona of read.personas.filter((one) => one.name !== "mine")) {
            expect(persona).toMatchObject({ layer: "baseline", extends: null });
            expect(persona.body.length).toBeGreaterThan(0);
          }
          expect(personas.get("mine")).toMatchObject({
            layer: "user",
            description: "A Persona of my own",
            body: expect.stringContaining("Do it my way."),
          });
          expect(read.errors).toEqual([expect.stringContaining("unloadable.md")]);

          // `persona show` gives the same data.
          const shown = yield* collie(world, ["persona", "show", "mine"]);
          expect(shown.envelope.data).toEqual({ persona: personas.get("mine") });

          // Nothing was provisioned to read them.
          for (const dir of [world.user, `${world.install}/workflows`])
            for (const made of ["package.json", "node_modules", "bun.lock"])
              expect(yield* fs.exists(`${dir}/${made}`)).toBe(false);

          // An added read: the protocol is the one Desktops already speak.
          expect(PROTOCOL).toBe(4);
        }).pipe(Effect.orDie),
      [],
    ),
  60_000,
);
