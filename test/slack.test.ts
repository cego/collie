import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Logger } from "effect";
import { inspect } from "node:util";
import { slackApi } from "../src/slack";
import { fakeSlack } from "./support/slack";
import { runEffect } from "./support/effect";

test("a bot token reads its workspace and posting user; invalid_auth refuses without logging it", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      const token = "xoxb-fixture-secret";
      const logs: unknown[] = [];
      const api = slackApi(token, fake.client);
      const logger = Logger.make(({ message }) => {
        logs.push(message);
      });
      const identity = yield* api.auth().pipe(Effect.provide(Logger.layer([logger])));
      expect(identity).toEqual({
        team: "Example Co",
        user: "collie",
        team_id: "T123",
        user_id: "U234",
        bot_id: "B345",
        url: "https://example.slack.com/",
      });
      fake.refuse("invalid_auth");
      const refused = yield* api.auth().pipe(Effect.flip, Effect.provide(Logger.layer([logger])));
      expect(refused).toBe("Slack auth.test: invalid_auth");
      expect(Arr.map(fake.calls, (call) => call.method)).toEqual(["auth.test", "auth.test"]);
      expect(inspect({ logs, calls: fake.calls, refused })).not.toContain(token);
    }),
  ));

test("the adapter opens one person's DM, posts, and asks for a permalink with Slack's returned channel and ts", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      const api = slackApi("xoxb-fixture", fake.client);
      const channel = yield* api.open("U789");
      const posted = yield* api.post(channel, "The release is ready");
      expect(yield* api.permalink(posted.channel, posted.ts)).toBe(
        "https://example.slack.com/archives/D123/p1503435956000247",
      );
      expect(fake.calls).toEqual([
        { method: "conversations.open", parameters: { users: "U789" } },
        {
          method: "chat.postMessage",
          parameters: { channel: "D123", text: "The release is ready" },
        },
        {
          method: "chat.getPermalink",
          parameters: { channel: "D123", message_ts: "1503435956.000247" },
        },
      ]);
    }),
  ));

test("people follow both users.list pages and omit bots and deleted users", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      expect(yield* slackApi("xoxb-fixture", fake.client).people()).toEqual([
        { id: "U456", name: "Sam" },
        { id: "U789", name: "Alex Example" },
      ]);
      expect(fake.calls).toEqual([
        { method: "users.list", parameters: { limit: "200", cursor: "" } },
        { method: "users.list", parameters: { limit: "200", cursor: "people-next" } },
      ]);
    }),
  ));

test("channels follow both cursor pages and only offer conversations Collie belongs to", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      expect(yield* slackApi("xoxb-fixture", fake.client).channels()).toEqual([
        { id: "C123", name: "engineering", is_private: false },
        { id: "G234", name: "releases", is_private: true },
      ]);
      expect(fake.calls).toEqual([
        {
          method: "conversations.list",
          parameters: {
            types: "public_channel,private_channel",
            exclude_archived: "true",
            limit: "200",
            cursor: "",
          },
        },
        {
          method: "conversations.list",
          parameters: {
            types: "public_channel,private_channel",
            exclude_archived: "true",
            limit: "200",
            cursor: "channels-next",
          },
        },
      ]);
    }),
  ));
