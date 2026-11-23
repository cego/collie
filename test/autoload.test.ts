import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import type { Scope } from "effect";
import { Config, ConfigProvider, Effect, FileSystem, Option, Schema, flow, Result } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { connect } from "../src/host";
import { runEffect } from "./support/effect";
import { events, stopHost, until } from "./support/host";

const repo = new URL("../", import.meta.url).pathname;
const fixtures = `${repo}test/fixtures/workflows`;

const asCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String))),
  Result.getOrThrow,
);

const PROMPT = "A shorter prompt.\n";

const MODULE = ["proof.workflow.ts", "helper.ts", "notes.md"] as const;

interface Project {
  readonly root: string;
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
            yield* fs.makeDirectory(`${root}/.collie/workflows`, { recursive: true });
            return { root, dir: `${root}/.collie/workflows` };
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
              COLLIE_ROOT: install,
              COLLIE_USER_DIR: `${install}/user`,
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

test("a module saved where an author saves one is found and run, with nothing registered by hand", () =>
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
          description: "Records one launch, then waits to be answered.",
          layer: "user",
          path: `${world.user}/proof.workflow.ts`,
          inputs: [
            {
              name: "note",
              required: true,
              strategy: "goal",
              schema: { type: "string", $defs: {} },
              limits: [],
            },
          ],
          outcome: null,
        },
      ]);

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
  ));

test("two projects run their own implementation of one id at the same time", () =>
  proves("collie-autoload-projects-", (world) =>
    Effect.gen(function* () {
      const one = yield* world.project("one");
      const two = yield* world.project("two");
      yield* save(one.dir, MODULE);
      yield* save(two.dir, MODULE);
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

      expect(new Set(Arr.map(started, (one) => one.registration)).size).toBe(2);
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
          () => client.status({ runId: started[0].runId }),
          (status) => status.status === "complete",
        ),
      ).toEqual({ status: "complete", value: "note:a=ok" });
      expect(
        yield* until(
          () => client.status({ runId: started[1].runId }),
          (status) => status.status === "complete",
        ),
      ).toEqual({ status: "complete", value: "theirs:b=ok" });
      yield* stopHost(world.state);
    }),
  ));

test("an edited entry, helper and prompt reach the next run while the one going keeps its own", () =>
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

      const entry = yield* fs.readFileString(`${world.user}/proof.workflow.ts`).pipe(Effect.orDie);
      yield* write(
        `${world.user}/proof.workflow.ts`,
        pipe_(
          entry,
          Str.replace(
            'title: "A workflow that waits for a decision",',
            'title: "Edited while a run was waiting",',
          ),
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
  ));

test("an override that cannot be read names its own file, and the entry beside it still runs", () =>
  proves("collie-autoload-broken-", (world) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* world.project("thing");
      yield* save(world.user, [...MODULE, "plain.workflow.ts"]);
      const broken = `${project.dir}/proof.workflow.ts`;
      yield* write(broken, "export const id = ;\n");

      const client = yield* connect(world.state).pipe(Effect.orDie);
      const found = yield* client.discover({ project: project.root }).pipe(Effect.orDie);
      expect(Arr.map(found.entries, (entry) => entry.id)).toEqual(["plain"]);
      expect(
        Arr.map(found.problems, (problem) => [problem.id, problem.layer, problem.path]),
      ).toEqual([["proof", "project", broken]]);

      const refused = yield* client
        .start({ project: project.root, id: "proof", request: "req-1", input: { note: "no" } })
        .pipe(Effect.flip, Effect.orDie);
      expect(refused.reason).toContain(broken);

      const plain = yield* client
        .start({ project: project.root, id: "plain", request: "req-2", input: { note: "fine" } })
        .pipe(Effect.orDie);
      expect(
        yield* until(
          () => client.status({ runId: plain.runId }),
          (status) => status.status === "complete",
        ),
      ).toEqual({ status: "complete", value: "plain:fine" });

      yield* fs.remove(broken).pipe(Effect.orDie);
      const repaired = yield* client.discover({ project: project.root }).pipe(Effect.orDie);
      expect(repaired.problems).toEqual([]);
      expect(Arr.map(repaired.entries, (entry) => [entry.id, entry.layer])).toEqual([
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
  ));

test("a host that replaces one reads the files as they are now, and a module put back is usable again", () =>
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

      yield* stopHost(world.state);
      yield* fs.remove(`${world.user}/proof.workflow.ts`).pipe(Effect.orDie);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(world.state);
          const held = yield* client.registrations();
          expect(held.live).toEqual([]);
          expect(Arr.join(held.unavailable, "\n")).toContain("proof.workflow.ts");
          const refused = yield* client.status({ runId }).pipe(Effect.flip);
          expect(refused.reason).toContain("proof.workflow.ts");
        }).pipe(Effect.orDie),
      );
      yield* stopHost(world.state);

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
          expect(
            Arr.filter(yield* events(world.state, runId), (line) =>
              pipe_(line, Str.startsWith("launch")),
            ),
          ).toHaveLength(1);
        }),
      );
      yield* stopHost(world.state);
    }),
  ));
