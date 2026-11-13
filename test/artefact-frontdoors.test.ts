import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { withArtefacts } from "../src/artefact-client";
import { frontDoor, socketOf } from "../src/host";
import { artefactsOn, artefactReadOn, artefactSeenOn } from "../desktop/src/bun/machine";
import { runCommand } from "../src/flows";
import { readEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { collie, proves } from "./support/world";
import { runEffect } from "./support/effect";

test("an old host's absent capability refuses catalogue writes with an upgrade explanation", () =>
  runEffect(
    Effect.gen(function* () {
      let writes = 0;
      const door = {
        board: () =>
          Stream.make({
            _tag: "Snapshot" as const,
            installation: "old",
            build: "old",
            protocol: 5,
            herds: [],
            tasks: [],
            seq: 0,
          }),
      };
      const result = yield* withArtefacts(
        door.board(),
        Effect.sync(() => ++writes),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: expect.stringContaining("Upgrade") });
      expect(writes).toBe(0);
    }),
  ));

test(
  "CLI and agent registration deliver files through the shared host catalogue",
  () =>
    proves(
      "collie-register-doors-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const started = yield* collie(world, [
            "run",
            "start",
            "plain",
            "--input",
            "note=register",
          ]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data);
          yield* collie(world, ["run", "wait", runId]);
          const file = `${world.project}/answer.md`;
          yield* fs.writeFileString(file, "# Delivered\n");
          const cli = yield* collie(world, [
            "run",
            "artefact",
            "register",
            runId,
            "--path",
            file,
            "--title",
            "The answer",
            "--request-id",
            "register-cli",
          ]);
          expect(cli.envelope.ok).toBe(true);
          const registered = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ item: Schema.Struct({ id: Schema.String, title: Schema.String }) }),
          )(cli.envelope.data);
          expect(registered.item.title).toBe("The answer");
          const input = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            actions: [{ kind: "artefact_register", run: runId, path: file, title: "Agent title" }],
          });
          const tool = yield* collie(world, ["tools", "call", "collie_do", "--input", input]);
          expect(tool.envelope.ok).toBe(true);
          expect(tool.envelope.data).toMatchObject({
            text: expect.stringContaining(registered.item.id),
          });
          const desktop = yield* frontDoor(socketOf(world.state));
          const found = (yield* desktop.artefacts({ runId })).items;
          expect(found).toHaveLength(1);
          expect(found[0]).toMatchObject({
            id: registered.item.id,
            title: "Agent title",
            revision: 1,
          });
          expect(
            Buffer.from(
              (yield* desktop.artefactRead({
                runId,
                id: registered.item.id,
                revision: 1,
                offset: 0,
              })).content,
              "base64",
            ).toString(),
          ).toBe("# Delivered\n");
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "CLI, tools, terminal board and Desktop use one catalogue and the inspected revision",
  () =>
    proves(
      "collie-artefact-doors-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const start = yield* collie(world, ["run", "start", "plain", "--input", "note=material"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(start.envelope.data);
          yield* collie(world, ["run", "wait", runId]);
          const dir = `${world.state}/runs/${runId}/handoffs`;
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(`${dir}/note.md`, "# First\n");
          const desktop = yield* frontDoor(socketOf(world.state));
          const door = {
            machine: { installation: "local", profile: "local", name: "Local" },
            desktop,
          };
          const first = yield* artefactsOn(door, true, runId, true);
          const item = first.items[0]!;
          expect(item.ref).toBe("handoff:note.md");
          const listed = yield* collie(world, ["run", "artefacts", runId]);
          expect(listed.envelope.data).toMatchObject({
            items: [{ id: item.id, revision: 1, seen: null }],
          });
          const input = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            run: runId,
          });
          const called = yield* collie(world, [
            "tools",
            "call",
            "collie_artefacts",
            "--input",
            input,
          ]);
          const tool = yield* Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(
            called.envelope.data,
          );
          expect(tool.text).toContain(item.id);
          expect(tool.text).toContain('"seen":null');
          yield* fs.writeFileString(`${dir}/note.md`, "# Second\n");
          yield* artefactsOn(door, true, runId, true);
          const old = yield* artefactReadOn(door, runId, item.id, 1, 0);
          expect(Buffer.from(old.content, "base64").toString()).toBe("# First\n");
          const seen = yield* artefactSeenOn(door, runId, item.id, 1, "desktop-old");
          expect(seen).toMatchObject({ revision: 2, seen: { revision: 1 } });
          const env = readEnv({
            HOME: world.home,
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.user,
            COLLIE_CWD: world.project,
          });
          const note = yield* runCommand(
            {
              herdr: new Herdr(env),
              session: null,
              workspaceId: null,
              cwd: world.project,
              stateDir: world.state,
              pluginRoot: world.install,
              userDir: world.user,
            },
            env,
            { _tag: "SeeArtefact", runId, id: item.id, revision: null },
            { menu: () => Effect.succeed(null), ask: () => Effect.succeed(null) },
          );
          expect(note).toContain("unseen");
          const data = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            actions: [{ kind: "artefact_seen", run: runId, id: item.id, revision: 2 }],
          });
          const marked = yield* collie(world, ["tools", "call", "collie_do", "--input", data]);
          expect(marked.envelope.ok).toBe(true);
          expect((yield* artefactsOn(door, true, runId)).items[0]!.seen?.revision).toBe(2);
          const clear = yield* collie(world, [
            "run",
            "artefact",
            "unseen",
            runId,
            item.id,
            "--request-id",
            "cli-clear",
          ]);
          expect(clear.envelope.ok).toBe(true);
          expect((yield* artefactsOn(door, true, runId)).items[0]!.seen).toBeNull();
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);
