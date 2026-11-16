import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { attachmentsDir, listAttachments } from "../src/attachments";
import { frontDoor, socketOf } from "../src/host";
import { readAudit } from "../src/audit";
import { registerAgent } from "../src/registry";
import { recordsAt } from "./support/records";
import { collie, proves } from "./support/world";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

test(
  "links, Claude artefacts and Sites register from every door without provider access",
  () =>
    proves(
      "collie-register-links-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=links"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data);
          yield* collie(world, ["run", "wait", runId]);
          const door = yield* frontDoor(socketOf(world.state));
          const runDir = `${world.state}/runs/${runId}`;
          const evidenceBefore = yield* fs
            .readDirectory(`${world.state}/evidence/${runId}`, { recursive: true })
            .pipe(Effect.orElseSucceed(() => []));

          const cli = yield* collie(world, [
            "run",
            "artefact",
            "register",
            runId,
            "--url",
            "https://example.com/report",
            "--title",
            "Report",
            "--request-id",
            "link-cli",
          ]);
          expect(cli.envelope.ok).toBe(true);
          const link = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ item: Schema.Struct({ id: Schema.String }) }),
          )(cli.envelope.data);

          yield* registerAgent(
            { session: null, workspaceId: null, cwd: world.project },
            {
              role: "implementer",
              agent: "builder",
              paneId: "p-1",
              workspaceId: null,
              runId,
              workflow: "plain",
              at: "2026-11-13T00:00:00.000Z",
            },
          ).pipe(Effect.provide(recordsAt(world.state)));
          const claude = yield* collie(
            world,
            [
              "tools",
              "call",
              "collie_do",
              "--input",
              yield* encode({
                actions: [
                  {
                    kind: "artefact_register",
                    run: runId,
                    url: "https://claude.ai/code/artifact/0b8c",
                    artefactKind: "claude-artefact",
                    title: "Design notes",
                    provider: {
                      name: "claude",
                      namespace: "org-1",
                      resource: "0b8c",
                      version: "3",
                    },
                  },
                ],
              }),
            ],
            { COLLIE_RUN: runId, COLLIE_AGENT: "builder" },
          );
          expect(claude.envelope.ok).toBe(true);
          expect(claude.envelope.data).toMatchObject({
            text: expect.stringContaining("registered"),
          });
          const site = yield* door.artefactRegister({
            runId,
            request: "site",
            url: "https://demo.sites.example/",
            kind: "codex-site",
            provider: { name: "codex-sites", namespace: "ws-a", resource: "proj_1", version: "d1" },
          });
          const manifest = yield* door.artefactRegister({
            runId,
            request: "manifest",
            kind: "codex-site",
            title: "Site from its manifest",
            provider: { name: "codex-sites", namespace: "ws-a", resource: "proj_2" },
          });
          const elsewhere = yield* door.artefactRegister({
            runId,
            request: "site-other-namespace",
            kind: "codex-site",
            title: "Same project id, other workspace",
            provider: { name: "codex-sites", namespace: "ws-b", resource: "proj_1", version: "d1" },
          });
          const again = yield* door.artefactRegister({
            runId,
            request: "site-again",
            url: "https://demo.sites.example/",
            kind: "codex-site",
            provider: { name: "codex-sites", namespace: "ws-a", resource: "proj_1", version: "d1" },
          });
          expect(again.item.id).toBe(site.item.id);
          expect(again.item.revision).toBe(1);
          expect(elsewhere.item.id).not.toBe(site.item.id);
          expect(manifest.item.url).toBeUndefined();
          expect(manifest.item.provider?.version).toBeNull();

          const items = (yield* door.artefacts({ runId })).items;
          expect(items).toHaveLength(5);
          const one = (id: string) => Arr.findFirst(items, (item) => item.id === id);
          const listedLink = one(link.item.id);
          expect(listedLink._tag === "Some" && listedLink.value).toMatchObject({
            kind: "link",
            url: "https://example.com/report",
            created: null,
            updated: null,
            sourceAvailability: "untracked",
            retainedAvailability: "none",
            digest: "",
          });
          const agentClaude = Arr.findFirst(items, (item) => item.kind === "claude-artefact");
          expect(agentClaude._tag === "Some" && agentClaude.value).toMatchObject({
            url: "https://claude.ai/code/artifact/0b8c",
            provider: {
              name: "claude",
              namespace: "org-1",
              resource: "0b8c",
              version: "3",
              provenance: "caller-reported",
            },
            registeredBy: { origin: "agent", from: { run: runId, agent: "builder" } },
          });
          expect(
            yield* door
              .artefactRead({ runId, id: link.item.id, revision: 1, offset: 0 })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "HostRefused" });

          const newer = yield* door.artefactRegister({
            runId,
            request: "site-v2",
            url: "https://demo.sites.example/",
            kind: "codex-site",
            provider: { name: "codex-sites", namespace: "ws-a", resource: "proj_1", version: "d2" },
          });
          expect(newer.item).toMatchObject({ id: site.item.id, revision: 2 });
          const retarget = yield* door.artefactRegister({
            runId,
            request: "link-retarget",
            id: link.item.id,
            url: "https://example.com/report-2",
          });
          expect(retarget.item).toMatchObject({ revision: 2, url: "https://example.com/report-2" });
          const renamed = yield* door.artefactRegister({
            runId,
            request: "link-rename",
            id: link.item.id,
            url: "https://example.com/report-2",
            title: "Renamed",
          });
          expect(renamed.item).toMatchObject({ revision: 2, title: "Renamed" });
          const marked = yield* door.artefactSeen({
            runId,
            id: site.item.id,
            revision: 1,
            request: "seen-listed",
          });
          expect(marked).toMatchObject({ revision: 2, seen: { revision: 1 } });

          const extension = yield* door.artefactRegister({
            runId,
            request: "extension",
            url: "https://diagrams.example/d/9",
            kind: "acme.dev/diagram",
            metadata: { layers: [{ name: "<script>alert(1)</script>" }], zoom: 2 },
            created: "2026-03-04T05:06:07.000Z",
          });
          expect(extension.item).toMatchObject({
            kind: "acme.dev/diagram",
            metadata: { layers: [{ name: "<script>alert(1)</script>" }], zoom: 2 },
            created: { at: "2026-03-04T05:06:07.000Z", provenance: "caller-reported" },
            updated: null,
          });

          const count = (yield* door.artefacts({ runId })).items.length;
          for (const [request, bad] of [
            ["bad-scheme", { url: "javascript:alert(1)" }],
            ["bad-file-url", { url: "file:///etc/passwd" }],
            ["bad-url", { url: "https://" }],
            ["no-locator", { title: "nothing to find" }],
            ["bad-kind", { url: "https://example.com/k", kind: "<b>bold</b>" }],
            ["bad-date", { url: "https://example.com/d", updated: "yesterday" }],
            [
              "big-metadata",
              { url: "https://example.com/m", metadata: { blob: Str.repeat(16_384)("x") } },
            ],
            [
              "long-description",
              { url: "https://example.com/l", description: Str.repeat(4097)("d") },
            ],
          ] as const) {
            expect(
              yield* door.artefactRegister({ runId, request, ...bad }).pipe(Effect.flip),
            ).toMatchObject({ _tag: "HostRefused" });
          }
          expect((yield* door.artefacts({ runId })).items).toHaveLength(count);

          expect(yield* listAttachments(attachmentsDir(runDir))).toEqual([]);
          expect(
            yield* fs
              .readDirectory(`${world.state}/evidence/${runId}`, { recursive: true })
              .pipe(Effect.orElseSucceed(() => [])),
          ).toEqual(evidenceBefore);
          const audit = yield* readAudit(runDir);
          expect(
            Arr.filter(audit, (line) => line.operation === "artefact-register").length,
          ).toBeGreaterThanOrEqual(8);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "an exported file and a provider version stay separate facts",
  () =>
    proves(
      "collie-register-export-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=export"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data);
          yield* collie(world, ["run", "wait", runId]);
          const door = yield* frontDoor(socketOf(world.state));
          const file = `${world.project}/export/notes.md`;
          yield* fs.makeDirectory(`${world.project}/export`, { recursive: true });
          yield* fs.writeFileString(file, "# Exported once\n");
          const first = yield* door.artefactRegister({
            runId,
            request: "export",
            path: file,
            url: "https://claude.ai/code/artifact/abc",
            kind: "claude-artefact",
            provider: { name: "claude", namespace: "org-1", resource: "abc", version: "1" },
          });
          expect(first.item).toMatchObject({
            revision: 1,
            source: "https://claude.ai/code/artifact/abc",
            export: { source: file, availability: "available" },
            created: null,
            updated: null,
            sourceAvailability: "untracked",
            retainedAvailability: "available",
            tracking: "local",
          });
          yield* fs.writeFileString(file, "# Edited locally\n");
          const refreshed = (yield* door.artefacts({ runId, refresh: true })).items[0]!;
          expect(refreshed).toMatchObject({
            revision: 2,
            provider: { version: "1", provenance: "caller-reported" },
            sourceAvailability: "untracked",
            created: null,
            updated: null,
          });
          expect(refreshed.digest).not.toBe(first.item.digest);
          expect(refreshed.provider?.observedAt).toBe(first.item.provider?.observedAt);
          yield* fs.remove(file);
          const gone = (yield* door.artefacts({ runId, refresh: true })).items[0]!;
          expect(gone).toMatchObject({
            revision: 2,
            export: { availability: "missing" },
            sourceAvailability: "untracked",
            retainedAvailability: "available",
          });
          expect(
            Buffer.from(
              (yield* door.artefactRead({ runId, id: first.item.id, revision: 2, offset: 0 }))
                .content,
              "base64",
            ).toString(),
          ).toBe("# Edited locally\n");
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);
