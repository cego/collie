// Collie's OpenCode reporter plugin, loaded as OpenCode loads it and fed OpenCode's events.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { opencodeReporter } from "../src/harness";
import type { JsonObject } from "../src/schema";
import { runEffect } from "./support/effect";

interface OpenCodeEvent {
  readonly event: { readonly type: string; readonly properties: JsonObject };
}
interface Reporter {
  readonly CollieStatus: () => Promise<{ event: (input: OpenCodeEvent) => Promise<void> }>;
}

const loaded = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-reporter-" });
  const files = { sessionFile: `${dir}/agent.session`, tty: `${dir}/tty` };
  yield* fs.writeFileString(`${dir}/status.js`, opencodeReporter(files));
  yield* fs.writeFileString(files.tty, "");
  const plugin = yield* Effect.promise((): Promise<Reporter> => import(`${dir}/status.js`));
  const hooks = yield* Effect.promise(() => plugin.CollieStatus());
  const event = (type: string, properties: JsonObject) =>
    Effect.promise(() => hooks.event({ event: { type, properties } }));
  const read = (file: string) => fs.readFileString(file);
  return { ...files, event, read };
});

test("the reporter records the agent's own session, not a subagent's that arrived first", () =>
  runEffect(
    Effect.gen(function* () {
      const { sessionFile, event, read } = yield* loaded;
      yield* event("session.created", { info: { id: "ses_child", parentID: "ses_main" } });
      yield* event("session.created", { info: { id: "ses_main" } });
      yield* event("session.created", { info: { id: "ses_later" } });
      expect(yield* read(sessionFile)).toBe("ses_main");
    }),
  ));

test("the reporter reports the agent's own session working, then idle, and a subagent's not at all", () =>
  runEffect(
    Effect.gen(function* () {
      const { tty, event, read } = yield* loaded;
      yield* event("session.created", { info: { id: "ses_main" } });
      yield* event("session.status", { sessionID: "ses_main", status: { type: "busy" } });
      yield* event("session.created", { info: { id: "ses_child", parentID: "ses_main" } });
      yield* event("session.status", { sessionID: "ses_child", status: { type: "busy" } });
      yield* event("session.status", { sessionID: "ses_child", status: { type: "idle" } });
      yield* event("permission.asked", { sessionID: "ses_child" });
      yield* event("permission.replied", { sessionID: "ses_child" });
      yield* event("session.status", { sessionID: "ses_main", status: { type: "idle" } });
      expect(yield* read(tty)).toBe(
        Arr.join(
          [
            "\x1b]7501;state=working:app=opencode\x1b\\",
            "\x1b]7501;state=blocked:kind=permission:app=opencode\x1b\\",
            "\x1b]7501;state=working:app=opencode\x1b\\",
            "\x1b]7501;state=idle:app=opencode\x1b\\",
          ],
          "",
        ),
      );
    }),
  ));
