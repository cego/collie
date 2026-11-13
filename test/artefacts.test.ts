import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, Option, Path, Stream } from "effect";
import * as Arr from "effect/Array";
import { connect, frontDoor, socketOf } from "../src/host";
import { stopHost, until } from "./support/host";
import { registeredAt } from "./support/records";
import { readAudit } from "../src/audit";
import { collie, proves } from "./support/world";
import { artefactsOn } from "../desktop/src/bun/machine";
import { recordIn, type RunDetail } from "../src/board-model";

test(
  "the host discovers only Run collections and retains their selected revision",
  () =>
    proves(
      "collie-artefacts-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
          const {
            data: { runId },
          } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              data: Schema.Struct({ runId: Schema.String }),
            }),
          )(started.envelope);
          yield* collie(world, ["run", "wait", runId]);
          const host = yield* connect(world.state);
          const proof = yield* Effect.all([host.runOutcomes({ runId }), host.runChecks({ runId })]);
          const dir = `${world.state}/runs/${runId}`;
          const fixtures = [
            [`${dir}/attachments/manual.pdf`, "%PDF-1.7"],
            [`${dir}/attachments/shot.png`, "image bytes"],
            [`${dir}/plan/issues/01.md`, "# First ticket\n"],
            [`${world.state}/evidence/${runId}/checks/check.log`, "first proof\n"],
            [`${dir}/handoffs/nested/note.txt`, "  first note\n"],
            [`${dir}/private/journal.json`, "private"],
            [`${dir}/output.json`, "{}"],
            [`${dir}/attachments/credentials.json`, "private credentials"],
          ];
          for (const [file, bytes] of fixtures) {
            yield* fs.makeDirectory(path.dirname(file!), { recursive: true });
            yield* fs.writeFileString(file!, bytes!);
          }
          const door = yield* frontDoor(socketOf(world.state));
          const found = yield* door.artefacts({ runId, refresh: true });
          expect(Arr.map(found.items, (one) => one.ref).sort()).toEqual([
            "attachment:manual.pdf",
            "attachment:shot.png",
            "evidence:checks/check.log",
            "handoff:nested/note.txt",
            "plan:issues/01.md",
          ]);
          expect(Arr.every(found.items, (one) => one.seen === null && one.created === null)).toBe(
            true,
          );
          const shown = yield* artefactsOn(
            { machine: { profile: "local", name: "Local" }, desktop: door },
            true,
            runId,
          );
          expect(Arr.map(shown.items, (one) => one.ref)).toEqual(
            Arr.map(found.items, (one) => one.ref),
          );
          for (const item of found.items)
            expect((yield* door.runFile({ runId, ref: item.ref, offset: 0, length: 1 })).size).toBe(
              item.size,
            );
          const note = Option.getOrThrow(
            Arr.findFirst(found.items, (one) => one.ref === "handoff:nested/note.txt"),
          );
          expect(note.registeredAt).toBeTruthy();
          yield* fs.writeFileString(`${dir}/handoffs/nested/note.txt`, "second note\n");
          const changed = yield* door.artefacts({ runId, refresh: true });
          const updated = Option.getOrThrow(
            Arr.findFirst(changed.items, (one) => one.id === note.id),
          );
          expect(updated.revision).toBe(2);
          expect(updated.registeredAt).toBe(note.registeredAt);
          const beforeDateEdit = yield* door.artefacts({ runId, refresh: true });
          expect(
            Option.getOrThrow(Arr.findFirst(beforeDateEdit.items, (one) => one.id === note.id))
              .revision,
          ).toBe(2);
          yield* fs.utimes(`${dir}/handoffs/nested/note.txt`, 1_700_000_000, 1_700_000_000);
          const dateOnly = Option.getOrThrow(
            Arr.findFirst(
              (yield* door.artefacts({ runId, refresh: true })).items,
              (one) => one.id === note.id,
            ),
          );
          expect(dateOnly.revision).toBe(2);
          expect(dateOnly.created).toBeNull();
          expect(dateOnly.updated).toMatchObject({
            at: "2023-11-14T22:13:20.000Z",
            provenance: "filesystem-mtime",
          });
          const read = yield* door.artefactRead({ runId, id: note.id, revision: 1, offset: 0 });
          expect(Buffer.from(read.content, "base64").toString()).toBe("  first note\n");
          expect(
            Option.getOrThrow(
              Arr.findFirst((yield* door.artefacts({ runId })).items, (one) => one.id === note.id),
            ).seen,
          ).toBeNull();
          expect(
            yield* Effect.all([host.runOutcomes({ runId }), host.runChecks({ runId })]),
          ).toEqual(proof);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "revision receipts survive races, retries and restart while source loss preserves retained bytes",
  () =>
    proves(
      "collie-artefact-seen-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, '[{"verdict":"done"}]');
          const attended = yield* collie(
            world,
            ["run", "start", "attended", "--input", "work=receipts"],
            { FAKE_HERDR_OUTPUTS: outputs },
          );
          const byAgent = (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(attended.envelope.data)).runId;
          const host = yield* connect(world.state);
          yield* until(
            () => host.run({ runId: byAgent }),
            (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
          );
          const agent = Option.getOrThrow(
            Arr.findFirst(yield* registeredAt(world.state), (entry) => entry.runId === byAgent),
          );
          const started = yield* collie(world, [
            "run",
            "start",
            "plain",
            "--input",
            "note=receipts",
          ]);
          const {
            data: { runId },
          } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ data: Schema.Struct({ runId: Schema.String }) }),
          )(started.envelope);
          yield* collie(world, ["run", "wait", runId]);
          const dir = `${world.state}/runs/${runId}`;
          yield* fs.makeDirectory(`${dir}/handoffs`, { recursive: true });
          const file = `${dir}/handoffs/progress.txt`;
          yield* fs.writeFileString(file, "first");
          let door = yield* frontDoor(socketOf(world.state));
          const first = Option.getOrThrow(
            Arr.findFirst(
              (yield* door.artefacts({ runId, refresh: true })).items,
              (one) => one.ref === "handoff:progress.txt",
            ),
          );
          yield* fs.writeFileString(file, "second");
          yield* door.artefacts({ runId, refresh: true });
          yield* door.declare({ frontDoor: "desktop" });
          const old = yield* door.artefactSeen({
            runId,
            id: first.id,
            revision: 1,
            request: "old",
          });
          expect(old.revision).toBe(2);
          expect(old.seen?.revision).toBe(1);
          door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({ frontDoor: "agent", from: { run: byAgent, agent: agent.agent } });
          const args = { runId, id: first.id, revision: 2, request: "current" };
          const concurrent = yield* Effect.all([door.artefactSeen(args), door.artefactSeen(args)], {
            concurrency: "unbounded",
          });
          expect(concurrent[0]).toEqual(concurrent[1]);
          const late = yield* door.artefactSeen({
            runId,
            id: first.id,
            revision: 1,
            request: "late",
          });
          expect(late.seen?.revision).toBe(2);
          yield* door.artefactSeen({ runId, id: first.id, revision: null, request: "clear" });
          expect((yield* door.artefactSeen(args)).seen?.revision).toBe(2);
          const conflict = yield* door.artefactSeen({ ...args, revision: null }).pipe(Effect.flip);
          expect(conflict._tag).toBe("RequestConflict");
          yield* stopHost(world.state);
          yield* collie(world, ["run", "show", runId]);
          door = yield* frontDoor(socketOf(world.state));
          const after = Option.getOrThrow(
            Arr.findFirst(
              (yield* door.artefacts({ runId, refresh: true })).items,
              (one) => one.id === first.id,
            ),
          );
          expect(after.seen).toBeNull();
          expect(after.revision).toBe(2);
          expect(after.registeredAt).toBe(first.registeredAt);
          yield* fs.remove(file);
          const missing = Option.getOrThrow(
            Arr.findFirst(
              (yield* door.artefacts({ runId, refresh: true })).items,
              (one) => one.id === first.id,
            ),
          );
          expect(missing.sourceAvailability).toBe("missing");
          expect(missing.retainedAvailability).toBe("available");
          expect(missing.revision).toBe(2);
          expect(
            Buffer.from(
              (yield* door.artefactRead({ runId, id: first.id, revision: 2, offset: 0 })).content,
              "base64",
            ).toString(),
          ).toBe("second");
          const audit = yield* readAudit(dir);
          expect(Arr.filter(audit, (one) => one.request === "current")).toHaveLength(1);
          expect(
            Option.getOrUndefined(Arr.findFirst(audit, (one) => one.request === "current"))?.actor
              .from?.agent,
          ).toBe(agent.agent);
          const input = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            actions: [{ kind: "artefact_seen", run: runId, id: first.id, revision: 2 }],
          });
          const managed = yield* collie(world, ["tools", "call", "collie_do", "--input", input], {
            COLLIE_RUN: byAgent,
            COLLIE_AGENT: agent.agent,
          });
          expect(managed.envelope.ok).toBe(true);
          expect((yield* door.artefacts({ runId })).items[0]!.seen?.revision).toBe(2);
        }),
      ["plain.workflow.ts", "attended.workflow.ts"],
    ),
  120_000,
);

test(
  "unchanged reconciliation keeps the record revision and answers Unchanged",
  () =>
    proves(
      "collie-artefact-revision-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const start = yield* collie(world, ["run", "start", "plain", "--input", "note=stable"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(start.envelope.data);
          yield* collie(world, ["run", "wait", runId]);
          const dir = `${world.state}/runs/${runId}/handoffs`;
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(`${dir}/note.txt`, "unchanged bytes");
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.artefacts({ runId, refresh: true });
          const record = Option.getOrThrow(
            yield* door
              .runDetail({ runId, tail: false, pages: 1, refreshMr: false, parts: true })
              .pipe(
                Stream.map(recordIn),
                Stream.filter((one): one is RunDetail => one !== null && one.pending?.length === 0),
                Stream.runHead,
              ),
          );
          expect(record.revision).toBeDefined();
          yield* door.artefacts({ runId, refresh: true });
          const next = Option.getOrThrow(
            yield* door
              .runDetail({
                runId,
                tail: false,
                pages: 1,
                refreshMr: false,
                parts: true,
                held: record.revision!,
              })
              .pipe(Stream.runHead),
          );
          expect(next).toMatchObject({ _tag: "Unchanged", revision: record.revision });
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);
