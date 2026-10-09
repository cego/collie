import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Crypto, Deferred, Effect, Fiber, FileSystem } from "effect";
import { Client } from "../desktop/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../desktop/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { loopbackTools } from "../desktop/src/bun/chat-endpoint";
import { FLOCK_TOOLS, type FlockChat } from "../desktop/src/bun/flock-tools";
import { FILE_TOOLS } from "../desktop/src/bun/file-tools";
import { NO_HUMAN } from "../desktop/src/bun/session";

const questions = {
  questions: [
    { question: "Where?", header: "Place", options: [{ label: "Here" }], multiSelect: false },
  ],
};

test("the loopback tools require their token, list the chat's tools and match a clicked question to its call", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "flock-endpoint-" });
      let said: string | undefined = "Use this computer";
      const flock: FlockChat = {
        machines: () => [],
        conversation: "flock@test",
        said: () => said,
        attachments: () => undefined,
        uploaded: new Map(),
        machineRule: () => "Here",
        setMachineRule: () => Effect.void,
        inSync: () => Effect.succeed("In sync"),
        chatHarness: () => ({ harness: "pi", model: undefined, runsOn: "pi/default" }),
        setChatHarness: () => Effect.succeed(null),
      };
      const services = yield* Effect.context<Crypto.Crypto | FileSystem.FileSystem>();
      const clicked = yield* Deferred.make<{ readonly Where: string }>();
      const asked = yield* Deferred.make<string>();
      const endpoint = yield* loopbackTools({
        dir,
        flock,
        run: (effect) => Effect.runPromise(effect.pipe(Effect.provideContext(services))),
        ask: (id, signal) =>
          Effect.runPromise(
            Deferred.succeed(asked, id).pipe(Effect.andThen(Deferred.await(clicked))),
            { signal },
          ),
        noticed: () => undefined,
        placement: () => undefined,
      });
      const { url, token } = yield* endpoint.start;
      const refused = new Client({ name: "refused", version: "1" });
      const rejected = yield* Effect.tryPromise(() =>
        refused.connect(new StreamableHTTPClientTransport(new URL(url))),
      ).pipe(Effect.exit);
      expect(rejected._tag).toBe("Failure");
      yield* Effect.promise(() => refused.close());
      const client = new Client({ name: "desktop-test", version: "1" });
      yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
      yield* Effect.promise(() =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        ),
      );
      const tools = yield* Effect.promise(() => client.listTools());
      expect(tools.tools.map(({ name }) => name)).toEqual(
        [...FLOCK_TOOLS, ...FILE_TOOLS].map(({ name }) => name).concat("AskUserQuestion"),
      );
      expect(
        yield* Effect.promise(() =>
          client.callTool({ name: "collie_machine_rule", arguments: {} }),
        ),
      ).toMatchObject({ content: [{ type: "text", text: 'The Machine rule is: "Here"' }] });
      yield* endpoint.begin;
      const waiting = yield* Effect.promise(() =>
        client.callTool({ name: "AskUserQuestion", arguments: questions }),
      ).pipe(Effect.forkChild);
      yield* endpoint.question("call-question", questions);
      expect(yield* Deferred.await(asked)).toBe("call-question");
      yield* Deferred.succeed(clicked, { Where: "Here" });
      expect(yield* Fiber.join(waiting)).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("Here") }],
      });
      said = undefined;
      yield* endpoint.begin;
      expect(
        yield* Effect.promise(() =>
          client.callTool({ name: "AskUserQuestion", arguments: questions }),
        ),
      ).toMatchObject({ content: [{ type: "text", text: NO_HUMAN }] });
      expect(yield* endpoint.start).toEqual({ url, token });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));
