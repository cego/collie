import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { saveSlackConnection, disconnectSlackConnection } from "../desktop/src/bun/slack";
import { credentialsFile, giveSlack } from "../desktop/src/bun/credentials";
import { givenCredentials } from "../desktop/src/bun/given";
import { localRoute } from "../desktop/src/bun/machine";
import { ranWith } from "../desktop/src/bun/onboarding";
import { fakeSlack } from "./support/slack";
import { runEffect } from "./support/effect";
import { slackApi } from "../src/slack";

test("a disconnected Machine removes its old token when it reconnects", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-slack-disconnect-" });
      const keyring = credentialsFile(`${dir}/desktop`, `${dir}/no-keyring`);
      const route = {
        ...localRoute([], "vm"),
        execute: (script: string, stdin?: Uint8Array) =>
          ranWith(["env", `HOME=${dir}`, "XDG_CONFIG_HOME=", "sh", "-c", script], stdin),
      };
      const given = yield* givenCredentials({
        dir,
        keyring,
        skipped: () => Effect.succeed([]),
        tell: () => Effect.void,
        give: {
          gitlab: () => Effect.succeed(null),
          helle: () => Effect.succeed(null),
          slack: (route, text) =>
            giveSlack([route], text).pipe(Effect.map((all) => all[0]!.failed)),
          "slack-user": () => Effect.succeed(null),
        },
      });
      yield* saveSlackConnection(
        "xoxb-fixture",
        keyring,
        (token) => given.giveEvery([route], "slack", token),
        (token) => slackApi(token, fakeSlack().client),
      );
      expect(yield* fs.exists(`${dir}/.config/collie/slack.env`)).toBe(true);
      yield* disconnectSlackConnection(keyring, (token) => given.giveEvery([], "slack", token));
      expect(yield* keyring.lookup("slack-token")).toBe("");
      yield* given.giveLacking(route);
      expect(yield* fs.exists(`${dir}/.config/collie/slack.env`)).toBe(false);
    }),
  ));

test("a stale public hand-over temporary file cannot expose the next Slack token", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-slack-mode-" });
      yield* fs.makeDirectory(`${dir}/.config/collie`, { recursive: true });
      yield* fs.writeFileString(`${dir}/.config/collie/slack.env.new`, "old", { mode: 0o644 });
      const route = {
        ...localRoute([], "vm"),
        execute: (script: string, stdin?: Uint8Array) =>
          ranWith(["env", `HOME=${dir}`, "XDG_CONFIG_HOME=", "sh", "-c", script], stdin),
      };
      expect((yield* giveSlack([route], "xoxb-new-secret"))[0]!.failed).toBeNull();
      expect((yield* fs.stat(`${dir}/.config/collie/slack.env`)).mode & 0o777).toBe(0o600);
    }),
  ));
