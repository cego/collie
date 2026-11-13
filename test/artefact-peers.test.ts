import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema } from "effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { ArtefactRegistered } from "../src/artefact-model";
import { PART_BYTES } from "../src/board-model";
import { connect, connectPeer } from "../src/host";
import { sha256Hex } from "../src/attachments";
import { runEffect } from "./support/effect";
import { stopHost } from "./support/host";
import { twoMachines } from "./support/peers";

test(
  "multipart peer registration retains bytes and presentation after checkout/upload loss and host restart",
  () =>
    runEffect(
      twoMachines(
        "collie-register-peer-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const started = yield* second.cli(["run", "start", "plain", "--input", "note=remote"]);
            const { runId } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ runId: Schema.String }),
            )(started.envelope.data);
            yield* second.cli(["run", "wait", runId]);
            yield* first.lists([second]);
            const checkout = `${first.world.project}/delivery-checkout`;
            yield* fs.makeDirectory(checkout);
            const clip = yield* fs.readFile(
              new URL("../desktop-rune/fixtures/artefact-video.mp4", import.meta.url).pathname,
            );
            const fixtures = [
              [
                "large.txt",
                new TextEncoder().encode(Str.repeat(PART_BYTES)("A") + "last part"),
                "text/plain",
              ],
              ["note.md", new TextEncoder().encode("# Remote note\n"), "text/markdown"],
              [
                "pixel.png",
                Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBFsAAAAASUVORK5CYII=",
                  "base64",
                ),
                "image/png",
              ],
              ["clip.mp4", clip, "video/mp4"],
            ] as const;
            const registered: Array<typeof ArtefactRegistered.Type> = [];
            for (const [name, bytes, mediaType] of fixtures) {
              const path = `${checkout}/${name}`;
              yield* fs.writeFile(path, bytes);
              const result = yield* first.cli([
                "run",
                "artefact",
                "register",
                runId,
                "--path",
                path,
                "--upload",
                "--request-id",
                `upload-${name}`,
              ]);
              expect(result.envelope).toMatchObject({ ok: true });
              const receipt = yield* Schema.decodeUnknownEffect(ArtefactRegistered)(
                result.envelope.data,
              );
              expect(receipt.item).toMatchObject({
                tracking: "snapshot",
                mediaType,
                digest: sha256Hex(bytes),
                title: name,
              });
              registered.push(receipt);
            }
            yield* fs.remove(checkout, { recursive: true });
            yield* fs.remove(`${second.world.state}/uploads`, { recursive: true });
            yield* stopHost(second.world.state);
            yield* second.cli(["run", "show", runId]);
            const peer = yield* connectPeer(first.world.state, "second", {
              as: "cli",
              client: "artefact-test",
            });
            for (const [index, [, expected]] of fixtures.entries()) {
              const receipt = registered[index]!;
              const parts: Uint8Array[] = [];
              for (let offset = 0; offset < expected.length; offset += PART_BYTES) {
                const part = yield* peer.artefactRead({
                  runId,
                  id: receipt.item.id,
                  revision: receipt.item.revision,
                  offset,
                });
                parts.push(Buffer.from(part.content, "base64"));
              }
              expect(sha256Hex(Buffer.concat(parts))).toBe(sha256Hex(expected));
              expect(Buffer.concat(parts)).toEqual(Buffer.from(expected));
            }
            const destination = Str.trim(
              yield* fs.readFileString(`${second.world.state}/installation`),
            );
            expect(Arr.map(registered, (one) => one.address)).toEqual(
              Arr.map(registered, (one) => ({
                installation: destination,
                run: runId,
                id: one.item.id,
              })),
            );
            expect((yield* peer.artefacts({ runId, refresh: true })).items).toHaveLength(4);
          }),
        ["plain.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "the CLI's search finds a paired Machine's material by its installation and names that Machine once it is offline",
  () =>
    runEffect(
      twoMachines(
        "collie-search-peer-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${second.world.project}/remote-findings.md`, "# Remote\n");
            const started = yield* second.cli([
              "run",
              "start",
              "plain",
              "--attach",
              `${second.world.project}/remote-findings.md`,
              "--input",
              "note=remote",
            ]);
            const { runId } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ runId: Schema.String }),
            )(started.envelope.data);
            yield* second.cli(["run", "wait", runId]);
            yield* first.lists([second]);
            expect((yield* first.cli(["run", "show", runId])).envelope.ok).toBe(true);
            const remote = Str.trim(yield* fs.readFileString(`${second.world.state}/installation`));
            const Found = Schema.Struct({
              items: Schema.Array(
                Schema.Struct({
                  installation: Schema.String,
                  machine: Schema.String,
                  item: Schema.Struct({
                    id: Schema.String,
                    run: Schema.String,
                    title: Schema.String,
                  }),
                }),
              ),
              machines: Schema.Array(
                Schema.Struct({ machine: Schema.String, state: Schema.String }),
              ),
            });
            let found = yield* Schema.decodeUnknownEffect(Found)(
              (yield* first.cli(["artefacts", "--query", "remote-findings"])).envelope.data,
            );
            for (let tries = 0; found.items.length === 0 && tries < 100; tries++)
              found = yield* Schema.decodeUnknownEffect(Found)(
                (yield* first.cli(["artefacts", "--query", "remote-findings"])).envelope.data,
              );
            expect(found.items).toEqual([
              {
                installation: remote,
                machine: "second",
                item: expect.objectContaining({ run: runId, title: "remote-findings.md" }),
              },
            ]);
            const qualified = yield* first.cli(["artefacts", "--run", `${remote}:${runId}`]);
            expect(qualified.envelope.data).toMatchObject({
              items: [{ installation: remote, item: { run: runId } }],
            });

            const itemId = found.items[0]!.item.id;
            const ownerRun = `${remote}:${runId}`;
            const inspected = yield* first.cli(["run", "artefact", "show", ownerRun, itemId]);
            expect(inspected.envelope.ok).toBe(true);
            const peer = yield* connectPeer(first.world.state, "second", {
              as: "cli",
              client: "search-test",
            });
            const original = Option.getOrThrow(
              Arr.findFirst((yield* peer.artefacts({ runId })).items, (item) => item.id === itemId),
            );
            const seen = yield* first.cli([
              "run",
              "artefact",
              "seen",
              ownerRun,
              itemId,
              "--revision",
              "1",
              "--request-id",
              "search-seen",
            ]);
            expect(seen.envelope.ok).toBe(true);
            yield* fs.writeFileString(original.source, "# Updated remotely\n");
            const refreshInput = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
              run: ownerRun,
              refresh: true,
            });
            const refresh = yield* first.cli([
              "tools",
              "call",
              "collie_artefacts",
              "--input",
              refreshInput,
            ]);
            expect(refresh.envelope.data).toMatchObject({
              text: expect.stringContaining('"revision":2'),
            });
            yield* stopHost(second.world.state);
            yield* second.cli(["run", "show", runId]);
            const restarted = yield* connect(second.world.state);
            const otherClient = yield* connectPeer(first.world.state, "second", {
              as: "desktop",
              client: "another-reader",
            });
            for (const client of [restarted, otherClient]) {
              const page = yield* client.artefactSearch({ run: runId, unseen: true });
              expect(page.items).toContainEqual(
                expect.objectContaining({
                  id: itemId,
                  revision: 2,
                  seen: expect.objectContaining({ revision: 1 }),
                }),
              );
            }

            yield* stopHost(second.world.state);
            yield* first.lists([]);
            const away = yield* first.cli(["artefacts", "--query", "remote-findings"]);
            expect(away.envelope.ok).toBe(true);
            expect(away.envelope.data).toMatchObject({
              items: [],
              complete: false,
              machines: expect.arrayContaining([
                expect.objectContaining({ machine: "second", state: "unreachable" }),
              ]),
            });
          }),
        ["plain.workflow.ts"],
      ),
    ),
  180_000,
);
