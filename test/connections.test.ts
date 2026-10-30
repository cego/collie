import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { CONNECTION_TIMEOUT_MS, readConnections, connectionsOnMachine } from "../src/connections";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";

test("one broken or stalled Connection leaves the other readings intact, with its own fix", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reading = yield* Effect.forkChild(
        readConnections([
          {
            id: "gitlab",
            fix: "glab auth login",
            read: Effect.succeed({ state: "ok", account: "mk", detail: "gitlab.example as mk" }),
          },
          { id: "github", fix: "gh auth login --web", read: Effect.die("credentials unreadable") },
          {
            id: "linear",
            fix: "claude mcp add",
            read: Effect.succeed({ state: "absent", detail: "no MCP", fix: "claude mcp add" }),
          },
          { id: "helle", fix: "check Helle's token", read: Effect.never },
        ]),
      );
      yield* TestClock.adjust(CONNECTION_TIMEOUT_MS);
      const found = yield* Fiber.join(reading);
      expect(found).toMatchObject([
        { id: "gitlab", reading: { state: "ok", account: "mk" } },
        { id: "github", reading: { state: "broken", fix: "gh auth login --web" } },
        { id: "linear", reading: { state: "absent", fix: "claude mcp add" } },
        { id: "helle", reading: { state: "broken", fix: "check Helle's token" } },
      ]);
      expect(found[1]?.reading.detail).toContain("credentials unreadable");
      expect(found[3]?.reading.detail).toContain("did not answer");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("Helle's registry entry keeps the token owner's account and the existing absent and broken fixes", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const fs = yield* FileSystem.FileSystem;
      const requests: string[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch: (request) => {
              requests.push(
                `${new URL(request.url).pathname} ${request.headers.get("authorization")}`,
              );
              return Response.json({ user_id: "user-mk" });
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      );
      const env = rig.pluginEnv({ COLLIE_HELLE_URL: `http://127.0.0.1:${server.port}` });
      const read = () =>
        connectionsOnMachine(env, () => Effect.succeed({ code: 127, stdout: "" })).pipe(
          Effect.map(
            (connections) =>
              Option.getOrUndefined(Arr.findFirst(connections, ({ id }) => id === "helle"))
                ?.reading,
          ),
        );
      const file = `${env.home}/.config/helle/env`;
      expect(yield* read()).toMatchObject({
        state: "absent",
        fix: `write HELLE_API_TOKEN=<token> to ${file}`,
      });
      yield* fs.makeDirectory(`${env.home}/.config/helle`, { recursive: true });
      yield* fs.writeFileString(file, "HELLE_API_URL=https://helle.cego.dk\n");
      expect(yield* read()).toMatchObject({
        state: "broken",
        fix: `add HELLE_API_TOKEN=<token> to ${file}`,
      });
      yield* fs.writeFileString(file, "HELLE_API_TOKEN=fixture-helle-token\n");
      expect(yield* read()).toEqual({
        state: "ok",
        account: "user-mk",
        detail: `http://127.0.0.1:${server.port} as user-mk`,
      });
      expect(requests).toEqual(["/api/v1/me Bearer fixture-helle-token"]);
    }),
  ));
