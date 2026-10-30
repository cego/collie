import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Logger } from "effect";
import { inspect } from "node:util";
import { saveSlackConnection, disconnectSlackConnection } from "../desktop/src/bun/slack";
import { credentialsFile, giveSlack } from "../desktop/src/bun/credentials";
import { givenCredentials } from "../desktop/src/bun/given";
import { localRoute } from "../desktop/src/bun/machine";
import { ranWith } from "../desktop/src/bun/onboarding";
import { probeSlack, slackToken } from "../src/slack-credentials";
import { fakeSlack } from "./support/slack";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { slackApi } from "../src/slack";
import { connectionCards } from "../desktop/src/shared/connections";

test("a pasted bot token is checked before storage, handed on stdin, retried after reconnect, and read by the registry", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => rig.close().pipe(Effect.orDie));
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-slack-" });
      const token = "xoxb-test-opaque-secret";
      const fake = fakeSlack();
      const commands: string[] = [];
      const inputs: string[] = [];
      const logs: unknown[] = [];
      const events: unknown[] = [];
      const keyring = credentialsFile(`${dir}/desktop`, `${dir}/no-keyring`);
      let online = false;
      const route = {
        ...localRoute([], "vm"),
        execute: (script: string, stdin?: Uint8Array) => {
          commands.push(script);
          inputs.push(new TextDecoder().decode(stdin));
          return online
            ? ranWith(["env", `HOME=${dir}`, "XDG_CONFIG_HOME=", "sh", "-c", script], stdin)
            : Effect.succeed({ code: 1, out: "", err: `unreachable ${token}` });
        },
      };
      const given = yield* givenCredentials({
        dir: `${dir}/given`,
        keyring,
        skipped: () => Effect.succeed([]),
        tell: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        give: {
          gitlab: () => Effect.succeed(null),
          helle: () => Effect.succeed(null),
          slack: (route, text) =>
            giveSlack([route], text).pipe(Effect.map((all) => all[0]!.failed)),
        },
      });
      const save = saveSlackConnection(
        token,
        keyring,
        (text) => given.giveEvery([route], "slack", text),
        (text) => slackApi(text, fake.client),
      );
      fake.refuse("invalid_auth");
      expect(yield* save.pipe(Effect.flip)).toBe("Slack auth.test: invalid_auth");
      expect(yield* keyring.lookup("slack-token")).toBeNull();
      expect(commands).toEqual([]);
      fake.refuse(null);
      const result = yield* save.pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              logs.push(message);
            }),
          ]),
        ),
      );
      expect(result.identity.team).toBe("Example Co");
      expect(result.given[0]!.failed).toBe("unreachable <redacted>");
      expect(yield* keyring.lookup("slack-token")).toBe(token);
      online = true;
      yield* given.giveLacking(route);
      const env = { ...rig.pluginEnv(), home: dir, raw: { XDG_CONFIG_HOME: "" } };
      expect(yield* slackToken(env)).toBe(token);
      expect((yield* fs.stat(`${dir}/.config/collie/slack.env`)).mode & 0o777).toBe(0o600);
      expect(yield* probeSlack(env, (token) => slackApi(token, fake.client))).toEqual({
        state: "ok",
        account: "Example Co",
        detail: "Posts as collie in Example Co",
      });
      expect(
        Option.getOrUndefined(
          Arr.findFirst(
            connectionCards([
              {
                profile: "vm",
                name: "vm",
                workflows: [],
                problem: null,
                connections: [
                  {
                    id: "slack",
                    reading: yield* probeSlack(env, (token) => slackApi(token, fake.client)),
                  },
                ],
              },
            ]),
            (card) => card.id === "slack",
          ),
        )!.account,
      ).toBe("Posts as collie in Example Co");
      fake.refuse("invalid_auth");
      expect(yield* probeSlack(env, (token) => slackApi(token, fake.client))).toMatchObject({
        state: "broken",
        detail: "Slack auth.test: invalid_auth",
      });
      expect(inspect({ commands, events, logs, result })).not.toContain(token);
      expect(inputs).toEqual([`SLACK_BOT_TOKEN=${token}\n`, `SLACK_BOT_TOKEN=${token}\n`]);
      expect(yield* fs.readFileString(`${dir}/given/given.json`)).not.toContain(token);
    }),
  ));

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
