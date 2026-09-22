// Saving a file is the whole of it: found, run, edited and recovered, through the host.
//
// Nothing here loads a module by hand. An author writes a file where authors write them,
// and the questions are the ones that decide whether that is enough — does the host find
// it, does an edit reach the next run without stopping the one going, do two projects with
// the same public id stay each other's business, and does a restart read the files as they
// are now. Every host is a real process, because none of those has an answer in one.

import { expect, test } from "bun:test";
import { Config, ConfigProvider, Effect, FileSystem, Option, Schema, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { connect } from "../src/host";
import { runEffect } from "./support/effect";
import { events, stopHost, until } from "./support/native";

const repo = new URL("../", import.meta.url).pathname;
const fixtures = `${repo}test/fixtures/native`;

/** The command a client starts a host with, as `connect` reads it. */
const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The prompt the entry imports, rewritten mid-test: its length is what the run records. */
const PROMPT = "A shorter prompt.\n";

/** A module, its helper and its prompt, as an author would have them beside each other. */
const MODULE = ["proof.workflow.ts", "helper.ts", "notes.md"] as const;

interface Project {
  /** The directory a client is working in, which is what it asks the host about. */
  readonly root: string;
  /** Where that project's own workflows are saved. */
  readonly dir: string;
}

interface World {
  readonly install: string;
  readonly user: string;
  readonly state: string;
  readonly project: (name: string) => Effect.Effect<Project, never, FileSystem.FileSystem>;
}

const save = (into: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const name of names) yield* fs.copyFile(`${fixtures}/${name}`, `${into}/${name}`);
  }).pipe(Effect.orDie);

const write = (file: string, text: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(file, text)),
    Effect.orDie,
  );

/**
 * An installation of Collie with nobody's workflows in it yet, a state directory for the
 * host, and projects made on demand. `HERDR_PLUGIN_ROOT` is what a client tells the host
 * it started, so the host looks for modules in this installation rather than the machine's.
 */
const proves = <A, E>(
  prefix: string,
  body: (
    world: World,
  ) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      const install = `${dir}/install`;
      const world: World = {
        install,
        user: `${install}/user/workflows`,
        state: `${dir}/state`,
        project: (name: string) =>
          Effect.gen(function* () {
            const root = `${dir}/${name}`;
            yield* fs.makeDirectory(`${root}/.herdr/workflows`, { recursive: true });
            return { root, dir: `${root}/.herdr/workflows` };
          }).pipe(Effect.orDie),
      };
      for (const made of [world.user, `${install}/workflows`, world.state]) {
        yield* fs.makeDirectory(made, { recursive: true }).pipe(Effect.orDie);
      }
      const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
      const command = Option.isSome(binary)
        ? [binary.value]
        : [process.execPath, `${repo}src/main.ts`];
      return yield* body(world).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              COLLIE_HOST: asCommand(command),
              HERDR_PLUGIN_ROOT: install,
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

test(
  "a module saved where an author saves one is found and run, with nothing registered by hand",
  () =>
    proves("collie-autoload-user-", (world) =>
      Effect.gen(function* () {
        const project = yield* world.project("thing");
        yield* save(world.user, MODULE);

        const client = yield* connect(world.state).pipe(Effect.orDie);
        const found = yield* client.discover({ project: project.root }).pipe(Effect.orDie);
        expect(found.problems).toEqual([]);
        expect(found.entries).toEqual([
          {
            id: "proof",
            title: "A workflow that waits for a decision",
            layer: "user",
            path: `${world.user}/proof.workflow.ts`,
            // What it takes, so a caller can ask for it without loading the module.
            inputs: [
              {
                name: "note",
                required: true,
                strategy: null,
                schema: { type: "string", $defs: {} },
                limits: [],
              },
            ],
          },
        ]);

        // No load: the id, the file the host found for it, and a request of the caller's.
        const started = yield* client
          .start({ project: project.root, id: "proof", request: "req-1", input: { note: "saved" } })
          .pipe(Effect.orDie);
        expect(started.registration).toBe("proof@1");
        expect(started.fresh).toBe(true);
        expect((yield* client.registrations().pipe(Effect.orDie)).live).toEqual(["proof@1"]);
        const runId = started.runId;

        yield* until(
          () => client.status({ runId }),
          (status) => status.status === "suspended",
        );
        yield* client
          .answer({ runId, decision: "decision", value: "yes", request: "answer-yes" })
          .pipe(Effect.orDie);
        expect(
          yield* until(
            () => client.status({ runId }),
            (status) => status.status === "complete",
          ),
        ).toEqual({ status: "complete", value: "note:saved=yes" });
        yield* stopHost(world.state);
      }),
    ),
  180_000,
);

test(
  "two projects run their own implementation of one id at the same time",
  () =>
    proves("collie-autoload-projects-", (world) =>
      Effect.gen(function* () {
        const one = yield* world.project("one");
        const two = yield* world.project("two");
        yield* save(one.dir, MODULE);
        yield* save(two.dir, MODULE);
        // The same public id, written differently: a project override is the point.
        yield* write(
          `${two.dir}/helper.ts`,
          "export const label = (note: string): string => `theirs:${note}`;\n",
        );

        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* Effect.all(
          [
            client.start({ project: one.root, id: "proof", request: "one", input: { note: "a" } }),
            client.start({ project: two.root, id: "proof", request: "two", input: { note: "b" } }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.orDie);

        // One id, two generations, and each project's own file behind its own.
        expect(new Set(started.map((one) => one.registration)).size).toBe(2);
        expect((yield* client.registrations().pipe(Effect.orDie)).live).toEqual([
          "proof@1",
          "proof@2",
        ]);
        expect(
          (yield* client.discover({ project: one.root }).pipe(Effect.orDie)).entries[0]?.path,
        ).toBe(`${one.dir}/proof.workflow.ts`);

        for (const admitted of started) {
          const runId = admitted.runId;
          yield* until(
            () => client.status({ runId }),
            (status) => status.status === "suspended",
          );
          yield* client
            .answer({ runId, decision: "decision", value: "ok", request: "answer-ok" })
            .pipe(Effect.orDie);
        }
        expect(
          yield* until(
            () => client.status({ runId: started[0]!.runId }),
            (status) => status.status === "complete",
          ),
        ).toEqual({ status: "complete", value: "note:a=ok" });
        expect(
          yield* until(
            () => client.status({ runId: started[1]!.runId }),
            (status) => status.status === "complete",
          ),
        ).toEqual({ status: "complete", value: "theirs:b=ok" });
        yield* stopHost(world.state);
      }),
    ),
  180_000,
);

test(
  "an edited entry, helper and prompt reach the next run while the one going keeps its own",
  () =>
    proves("collie-autoload-edit-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* world.project("thing");
        yield* save(world.user, MODULE);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const before = yield* client
          .start({ project: project.root, id: "proof", request: "before", input: { note: "old" } })
          .pipe(Effect.orDie);
        yield* until(
          () => client.status({ runId: before.runId }),
          (status) => status.status === "suspended",
        );

        // All three kinds of edit, while that run is parked on its decision.
        const entry = yield* fs
          .readFileString(`${world.user}/proof.workflow.ts`)
          .pipe(Effect.orDie);
        yield* write(
          `${world.user}/proof.workflow.ts`,
          entry.replace(
            'export const title = "A workflow that waits for a decision";',
            'export const title = "Edited while a run was waiting";',
          ),
        );
        yield* write(
          `${world.user}/helper.ts`,
          "export const label = (note: string): string => `edited:${note}`;\n",
        );
        yield* write(`${world.user}/notes.md`, PROMPT);

        expect(
          (yield* client.discover({ project: project.root }).pipe(Effect.orDie)).entries[0]?.title,
        ).toBe("Edited while a run was waiting");

        const after = yield* client
          .start({ project: project.root, id: "proof", request: "after", input: { note: "new" } })
          .pipe(Effect.orDie);
        expect(after.registration).toBe("proof@2");
        yield* until(
          () => client.status({ runId: after.runId }),
          (status) => status.status === "suspended",
        );
        // The helper the new run used, and the prompt it read: both as they are now.
        expect((yield* events(world.state, after.runId))[0]).toBe(
          `launch edited:new ${PROMPT.length}`,
        );

        for (const runId of [before.runId, after.runId]) {
          yield* client
            .answer({ runId, decision: "decision", value: "x", request: "answer-x" })
            .pipe(Effect.orDie);
        }
        expect(
          yield* until(
            () => client.status({ runId: before.runId }),
            (status) => status.status === "complete",
          ),
        ).toEqual({ status: "complete", value: "note:old=x" });
        expect(
          yield* until(
            () => client.status({ runId: after.runId }),
            (status) => status.status === "complete",
          ),
        ).toEqual({ status: "complete", value: "edited:new=x" });
        yield* stopHost(world.state);
      }),
    ),
  180_000,
);

test(
  "an override that cannot be read names its own file, and the entry beside it still runs",
  () =>
    proves("collie-autoload-broken-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* world.project("thing");
        yield* save(world.user, [...MODULE, "plain.workflow.ts"]);
        const broken = `${project.dir}/proof.workflow.ts`;
        yield* write(broken, "export const id = ;\n");

        const client = yield* connect(world.state).pipe(Effect.orDie);
        const found = yield* client.discover({ project: project.root }).pipe(Effect.orDie);
        expect(found.entries.map((entry) => entry.id)).toEqual(["plain"]);
        expect(found.problems.map((problem) => [problem.id, problem.layer, problem.path])).toEqual([
          ["proof", "project", broken],
        ]);

        // Refused by the file that is wrong, not run from the one it was written to replace.
        const refused = yield* client
          .start({ project: project.root, id: "proof", request: "req-1", input: { note: "no" } })
          .pipe(Effect.flip, Effect.orDie);
        expect(refused.reason).toContain(broken);

        // A new file appears while the host is running, and is as usable as the rest.
        const plain = yield* client
          .start({ project: project.root, id: "plain", request: "req-2", input: { note: "fine" } })
          .pipe(Effect.orDie);
        expect(
          yield* until(
            () => client.status({ runId: plain.runId }),
            (status) => status.status === "complete",
          ),
        ).toEqual({ status: "complete", value: "plain:fine" });

        // Deleting the override is not the same as breaking it: the layer below is back.
        yield* fs.remove(broken).pipe(Effect.orDie);
        const repaired = yield* client.discover({ project: project.root }).pipe(Effect.orDie);
        expect(repaired.problems).toEqual([]);
        expect(repaired.entries.map((entry) => [entry.id, entry.layer])).toEqual([
          ["plain", "user"],
          ["proof", "user"],
        ]);
        const repairedRun = yield* client
          .start({ project: project.root, id: "proof", request: "req-3", input: { note: "yes" } })
          .pipe(Effect.orDie);
        yield* until(
          () => client.status({ runId: repairedRun.runId }),
          (status) => status.status === "suspended",
        );
        yield* stopHost(world.state);
      }),
    ),
  180_000,
);

test(
  "a host that replaces one reads the files as they are now, and a module put back is usable again",
  () =>
    proves("collie-autoload-restart-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* world.project("thing");
        yield* save(world.user, MODULE);
        const runId = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(world.state);
            const started = yield* client.start({
              project: project.root,
              id: "proof",
              request: "req-1",
              input: { note: "durable" },
            });
            yield* until(
              () => client.status({ runId: started.runId }),
              (status) => status.status === "suspended",
            );
            return started.runId;
          }),
        ).pipe(Effect.orDie);

        // The host goes, and the module with it.
        yield* stopHost(world.state);
        yield* fs.remove(`${world.user}/proof.workflow.ts`).pipe(Effect.orDie);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(world.state).pipe(Effect.orDie);
            const held = yield* client.registrations().pipe(Effect.orDie);
            expect(held.live).toEqual([]);
            expect(held.unavailable.join("\n")).toContain("proof.workflow.ts");
            // Pending with the file to repair named, rather than failed or run on
            // whatever code is nearest.
            const refused = yield* client.status({ runId }).pipe(Effect.flip, Effect.orDie);
            expect(refused.reason).toContain("proof.workflow.ts");
          }),
        );
        yield* stopHost(world.state);

        // Put back unchanged: the next host registers it under the name the run started
        // on, and new work goes to that same generation rather than a second one.
        yield* save(world.user, MODULE);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(world.state).pipe(Effect.orDie);
            expect((yield* client.registrations().pipe(Effect.orDie)).live).toEqual(["proof@1"]);
            const started = yield* client
              .start({
                project: project.root,
                id: "proof",
                request: "req-2",
                input: { note: "new" },
              })
              .pipe(Effect.orDie);
            expect(started.registration).toBe("proof@1");

            yield* client
              .answer({ runId, decision: "decision", value: "back", request: "answer-back" })
              .pipe(Effect.orDie);
            expect(
              yield* until(
                () => client.status({ runId }),
                (status) => status.status === "complete",
              ),
            ).toEqual({ status: "complete", value: "note:durable=back" });
            // The Activity that ran before the restart ran once, whatever replay did.
            expect(
              (yield* events(world.state, runId)).filter((line) => line.startsWith("launch")),
            ).toHaveLength(1);
          }),
        );
        yield* stopHost(world.state);
      }),
    ),
  240_000,
);
