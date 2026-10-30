import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { Connection } from "../src/connection-model";
import { runEffect } from "./support/effect";
import { serveCatalogue } from "./support/catalogue";
import { exec } from "./support/command";

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Struct({ machine: Schema.Null, connections: Schema.Array(Connection) }),
  }),
);

test("collie connections --json reads the host's envelope, including the account and the actionable fix", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "connections-cli-" });
      const state = `${dir}/state`;
      yield* fs.makeDirectory(state, { recursive: true });
      yield* serveCatalogue(state, { catalogues: Effect.succeed([]) }, [
        { id: "gitlab", reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" } },
        {
          id: "github",
          reading: { state: "absent", detail: "no login", fix: "gh auth login --web" },
        },
      ]);
      const root = new URL("../", import.meta.url).pathname;
      const cli = (...args: ReadonlyArray<string>) =>
        exec([process.execPath, `${root}src/main.ts`, ...args], {
          cwd: root,
          env: {
            ...process.env,
            HOME: dir,
            HERDR_PLUGIN_ROOT: root,
            HERDR_PLUGIN_STATE_DIR: state,
            COLLIE_USER_DIR: `${dir}/config`,
          },
        });
      const printed = yield* cli("connections", "--json");
      expect(printed.exitCode).toBe(0);
      expect(Schema.decodeUnknownSync(Envelope)(printed.stdout)).toEqual({
        ok: true,
        data: {
          machine: null,
          connections: [
            {
              id: "gitlab",
              reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" },
            },
            {
              id: "github",
              reading: { state: "absent", detail: "no login", fix: "gh auth login --web" },
            },
          ],
        },
      });
      const human = yield* cli("connections");
      expect(human.stdout).toContain("gitlab    ok · mk");
      expect(human.stdout).toContain("Fix: gh auth login --web");
      const native = yield* cli("tools", "call", "collie_connections");
      expect(native.exitCode).toBe(0);
      expect(native.stdout).toBe(human.stdout);
    }),
  ));
