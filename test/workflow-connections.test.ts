import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { startRun } from "../src/lifecycle";
import { connect } from "../src/host";
import { stopHost, until } from "./support/host";
import { readDefinitions } from "../src/authoring";
import { hosted } from "./support/hosted";
import { Rig, FakeHerdr } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges, FORGE_HOST } from "./support/forge";
import { foundationLayer } from "../src/engine";
import { Host } from "../src/sdk";
import { ConfigProvider } from "effect";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";

test(
  "startRun refuses an absent required Connection with its fix before creating a Run",
  () =>
    hosted(
      "connections-needed-",
      ({ world, env }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            `${world.user}/needs-login.workflow.ts`,
            `
        import { defineWorkflow } from "collie";
        import { Effect } from "effect";
        export default defineWorkflow({
          id: "needs-login",
          connections: { needs: { helle: { with: "Holds the shared environment" } } },
          run: () => Effect.void,
        });
      `,
          );
          const started = yield* startRun(env, {
            door: { origin: "cli" },
            id: "needs-login",
            request: "missing-login",
            input: { json: {}, text: {}, inferred: [] },
            task: { mode: "new" },
          });
          expect(started).toMatchObject({ ok: false });
          if (started.ok) throw new Error("absent Helle accepted");
          const client = yield* connect(world.state);
          const helle = Option.getOrUndefined(
            Arr.findFirst(yield* client.connections(), ({ id }) => id === "helle"),
          )!.reading;
          if (helle.state === "ok") throw new Error("fixture has Helle credentials");
          expect(started.error.message).toContain(helle.fix);
          expect(
            Arr.filter(
              yield* fs.readDirectory(`${world.state}/runs`).pipe(Effect.orElseSucceed(() => [])),
              (name) => pipe_(name, Str.startsWith("run-")),
            ),
          ).toEqual([]);
        }),
      [],
    ),
  30_000,
);

test(
  "delivery without its forge returns the Connection fix before asking for any merge request",
  () =>
    runEffect(
      Effect.gen(function* () {
        const rig = yield* Effect.acquireRelease(Rig.make(), (rig) =>
          rig.close().pipe(Effect.orDie),
        );
        const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (bin) =>
          bin.restore(),
        );
        const forge = yield* forgeOnPath(bin, "github", {
          installed: true,
          loggedIn: [],
          login: null,
          mrs: [],
        });
        const api = yield* serveForges(forge);
        yield* exec(["git", "init", "--quiet", rig.projectDir]);
        yield* exec([
          "git",
          "-C",
          rig.projectDir,
          "remote",
          "add",
          "origin",
          `https://${FORGE_HOST.github}/owner/repo.git`,
        ]);
        const env = rig.pluginEnv();
        const answer = yield* Effect.gen(function* () {
          const host = yield* Host;
          return yield* host.mr({ cwd: rig.projectDir });
        }).pipe(
          Effect.provide(
            foundationLayer({
              dir: rig.stateDir,
              userDir: rig.userDir,
              placing: { herdr: new FakeHerdr(env), env },
            }).pipe(
              Layer.provide(
                ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: api })),
              ),
            ),
          ),
        );
        expect(answer).toMatchObject({
          ok: false,
          reason: "no GitHub login on this Machine. Fix: gh auth login --hostname github.com --web",
        });
        expect(
          Arr.filter(yield* forge.calls(), (line) => pipe_(line, Str.startsWith("pr "))),
        ).toEqual([]);
        expect(forge.requests()).toEqual([]);
        yield* bin.restore();
      }).pipe(Effect.scoped),
    ),
  30_000,
);

test(
  "a workflow skips its optional service step when absent and continues, and calls it once when connected",
  () =>
    hosted(
      "connections-step-",
      ({ world }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const calls: string[] = [];
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                port: 0,
                fetch: () => {
                  calls.push("filed");
                  return new Response("filed");
                },
              }),
            ),
            (server) => Effect.promise(() => server.stop(true)),
          );
          const client = yield* connect(world.state);
          const start = (request: string) =>
            client.start({
              project: world.project,
              id: "connection-step",
              request,
              input: { url: `http://127.0.0.1:${server.port}`, wait: false },
            });
          const absent = yield* start("absent");
          const skipped = yield* until(
            () => client.run({ runId: absent.runId }),
            (one) => one?.status.status === "complete" || one?.status.status === "failed",
          );
          expect(skipped?.status).toEqual({ status: "complete", value: "continued:absent" });
          expect(calls).toEqual([]);
          yield* fs.writeFileString(
            `${world.project}/.mcp.json`,
            '{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}}}',
          );
          const connected = yield* start("connected");
          const filed = yield* until(
            () => client.run({ runId: connected.runId }),
            (one) => one?.status.status === "complete",
          );
          expect(filed?.status).toEqual({ status: "complete", value: "continued:ok" });
          expect(calls).toEqual(["filed"]);
        }),
      ["connection-step.workflow.ts"],
    ),
  30_000,
);

test(
  "a Connection read inside an Activity keeps its journaled reading when the workflow replays",
  () =>
    hosted(
      "connections-replay-",
      ({ world }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* connect(world.state);
          const started = yield* client.start({
            project: world.project,
            id: "connection-step",
            request: "replay",
            input: { url: "http://127.0.0.1:9", wait: true },
          });
          const waiting = yield* until(
            () => client.run({ runId: started.runId }),
            (one) => (one?.waiting.length ?? 0) > 0 || one?.status.status === "failed",
          );
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(waiting), (present) =>
                Arr.map(present.waiting, (one) => one.name),
              ),
            ),
          ).toEqual(["continue"]);
          yield* fs.writeFileString(
            `${world.project}/.mcp.json`,
            '{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}}}',
          );
          yield* stopHost(world.state);
          const recovered = yield* connect(world.state);
          yield* recovered.answer({
            runId: started.runId,
            decision: "continue",
            request: "answer",
            value: "yes",
          });
          const done = yield* until(
            () => recovered.run({ runId: started.runId }),
            (one) => one?.status.status === "complete" || one?.status.status === "failed",
          );
          expect(done?.status).toEqual({ status: "complete", value: "continued:absent" });
        }),
      ["connection-step.workflow.ts"],
    ),
  30_000,
);

test(
  "definitions expose shipped Connection declarations and checking refuses a uses entry without its fallback text",
  () =>
    hosted(
      "connections-definitions-",
      ({ world, env }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = new URL("../", import.meta.url).pathname;
          yield* fs.copy(`${root}/workflows`, `${world.install}/workflows`);
          const view = yield* readDefinitions(env);
          expect(view.problems).toEqual([]);
          const review = Option.getOrUndefined(
            Arr.findFirst(view.workflows, ({ id }) => id === "review"),
          );
          expect(review?.metadata).toMatchObject({
            connections: {
              uses: {
                gitlab: {
                  with: "Reads and answers the merge request",
                  without: "Reviews the local diff only",
                },
              },
            },
          });
          const declared = {
            implement: { needs: [], uses: ["linear", "gitlab", "github"] },
            plan: { needs: [], uses: ["linear"] },
            release: { needs: ["helle", "gitlab"], uses: ["slack"] },
            renovate: { needs: ["linear", "gitlab"], uses: [] },
            stage: { needs: ["helle", "gitlab"], uses: [] },
            "tune-up": { needs: [], uses: ["linear", "gitlab", "github"] },
            review: { needs: [], uses: ["gitlab", "github"] },
            "self-improve": { needs: [], uses: ["gitlab", "github"] },
          };
          for (const [id, entries] of Rec.toEntries(declared)) {
            expect(
              Option.getOrUndefined(Arr.findFirst(view.workflows, (one) => one.id === id))
                ?.metadata,
            ).toMatchObject({
              connections: {
                needs: Rec.fromEntries(
                  Arr.map(entries.needs, (id) => [id, { with: expect.any(String) }]),
                ),
                uses: Rec.fromEntries(
                  Arr.map(entries.uses, (id) => [
                    id,
                    { with: expect.any(String), without: expect.any(String) },
                  ]),
                ),
              },
            });
          }
          yield* fs.writeFileString(
            `${world.user}/bad-connection.workflow.ts`,
            `
      import { defineWorkflow } from "collie"; import { Effect } from "effect";
      export default defineWorkflow({ id: "bad-connection", connections: { uses: { linear: { with: "Files issues" } } }, run: () => Effect.void });
    `,
          );
          const invalid = yield* readDefinitions(env);
          expect(invalid.problems).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "bad-connection",
                message: expect.stringContaining("linear"),
              }),
            ]),
          );
          expect(
            Option.getOrUndefined(
              Arr.findFirst(invalid.problems, ({ id }) => id === "bad-connection"),
            )?.message,
          ).toContain("without");
        }),
      [],
    ),
  30_000,
);

test(
  "an offer is hidden while its provider's used Connection is absent and checked again at invocation",
  () =>
    hosted(
      "connections-offers-",
      ({ world }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* connect(world.state);
          const started = yield* client.start({
            project: world.project,
            id: "connection-offers",
            request: "offers",
            input: {},
          });
          yield* until(
            () => client.run({ runId: started.runId }),
            (one) => one?.status.status === "complete",
          );
          expect(Arr.map(yield* client.offers({ runId: started.runId }), (one) => one.id)).toEqual([
            "local",
          ]);
          yield* fs.writeFileString(
            `${world.project}/.mcp.json`,
            '{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}}}',
          );
          expect(Arr.map(yield* client.offers({ runId: started.runId }), (one) => one.id)).toEqual([
            "file",
            "local",
          ]);
          yield* fs.remove(`${world.project}/.mcp.json`);
          const invoked = yield* client
            .invoke({
              runId: started.runId,
              offer: "file",
              input: {},
              request: "no-longer-available",
            })
            .pipe(Effect.result);
          expect(invoked._tag).toBe("Failure");
          const required = yield* client
            .invoke({ runId: started.runId, offer: "local", input: {}, request: "needs-helle" })
            .pipe(Effect.result);
          expect(required._tag).toBe("Failure");
          if (required._tag === "Failure")
            expect(required.failure.reason).toContain("Fix: write HELLE_API_TOKEN");
        }),
      ["connection-offers.workflow.ts", "connection-provider.workflow.ts"],
    ),
  30_000,
);
