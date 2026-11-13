import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Logger } from "effect";
import { inspect } from "node:util";
import { slackApi } from "../src/slack";
import { fakeSlack } from "./support/slack";
import { runEffect } from "./support/effect";

test("reaction reconciliation adds only missing reactions and accepts already_reacted", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      fake.messages([
        {
          channel: "C456",
          ts: "1700000000.000001",
          text: "Review https://gitlab.cego.dk/mk/collie/-/merge_requests/7",
        },
      ]);
      const api = slackApi("xoxp-fixture", fake.client);
      yield* api.reconcile("C456", "1700000000.000001", ["eyes", "memo"]);
      yield* api.reconcile("C456", "1700000000.000001", ["eyes", "memo", "white_check_mark"]);
      expect(fake.reactions()).toEqual(["eyes", "memo", "white_check_mark"]);
      expect(
        Arr.map(
          Arr.filter(fake.calls, (call) => call.method === "reactions.add"),
          (call) => call.parameters.name,
        ),
      ).toEqual(["eyes", "memo", "white_check_mark"]);
      fake.refuse("already_reacted", "reactions.add");
      yield* api.reconcile("C456", "1700000000.000001", ["heart"]);
    }),
  ));

test("a user token reads its workspace and user; invalid_auth refuses without logging it", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      const token = "xoxp-fixture-secret";
      const logs: unknown[] = [];
      const api = slackApi(token, fake.client);
      const logger = Logger.make(({ message }) => {
        logs.push(message);
      });
      const identity = yield* api.tokenOwner().pipe(Effect.provide(Logger.layer([logger])));
      expect(identity).toEqual({
        team: "Example Co",
        user: "sam",
        team_id: "T123",
        user_id: "U456",
        url: "https://example.slack.com/",
      });
      fake.refuse("invalid_auth");
      const refused = yield* api
        .tokenOwner()
        .pipe(Effect.flip, Effect.provide(Logger.layer([logger])));
      expect(refused).toBe("Slack auth.test: invalid_auth");
      expect(Arr.map(fake.calls, (call) => call.method)).toEqual(["auth.test", "auth.test"]);
      expect(inspect({ logs, calls: fake.calls, refused })).not.toContain(token);
    }),
  ));

test("the adapter posts, and asks for a permalink with Slack's returned channel and ts", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      const api = slackApi("xoxp-fixture", fake.client);
      const posted = yield* api.post("C123", "The release is ready");
      expect(yield* api.permalink(posted.channel, posted.ts)).toBe(
        "https://example.slack.com/archives/D123/p1503435956000247",
      );
      expect(fake.calls).toEqual([
        {
          method: "chat.postMessage",
          parameters: { channel: "C123", text: "The release is ready" },
        },
        {
          method: "chat.getPermalink",
          parameters: { channel: "D123", message_ts: "1503435956.000247" },
        },
      ]);
    }),
  ));

test("channels follow both cursor pages and only offer conversations the human belongs to", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      expect(yield* slackApi("xoxp-fixture", fake.client).channels()).toEqual([
        { id: "C456", name: "design", is_private: false },
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
