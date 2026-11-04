import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { redact } from "../src/redact";
import { slackApi } from "../src/slack";
import { probeSlackUser, slackUserToken } from "../src/slack-credentials";
import { fakeSlack } from "./support/slack";
import { runEffect } from "./support/effect";

const USER_TOKEN = "xoxe.xoxp-1-user-opaque-secret";

/** A Machine's home with `slack-user.env` holding `lines`, or no such file for null. */
const machine = (lines: string | null, bot?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "collie-slack-user-" });
    yield* fs.makeDirectory(`${home}/.config/collie`, { recursive: true });
    if (lines !== null) yield* fs.writeFileString(`${home}/.config/collie/slack-user.env`, lines);
    if (bot !== undefined)
      yield* fs.writeFileString(`${home}/.config/collie/slack.env`, `SLACK_BOT_TOKEN=${bot}\n`);
    const raw: Record<string, string> = bot === undefined ? {} : { SLACK_BOT_TOKEN: bot };
    return { home, raw };
  });

const signedIn = (token: string, user: string, team: string) =>
  `SLACK_USER_TOKEN=${token}\nSLACK_USER_ID=${user}\nSLACK_TEAM_ID=${team}\n`;

const FIX = "Open Desktop to renew Slack, or sign in again";

test("a Machine reads its slack-user Connection from Slack's answer about the token", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      const api = (token: string) => slackApi(token, fake.client);
      const read = (lines: string | null) =>
        Effect.flatMap(machine(lines), (env) => probeSlackUser(env, api));

      expect(yield* read(null)).toEqual({
        state: "absent",
        detail: "Not signed in to Slack as yourself on this Machine",
        fix: "Sign in to Slack as yourself in Desktop Settings › Connections",
      });
      expect(yield* read(signedIn(USER_TOKEN, "U456", "T123"))).toEqual({
        state: "ok",
        account: "Example Co",
        detail: "Posts approval requests as sam in Example Co",
      });
      expect(yield* read(signedIn(USER_TOKEN, "U999", "T123"))).toEqual({
        state: "broken",
        detail: "token belongs to U456, not U999",
        fix: FIX,
      });
      expect(yield* read(signedIn(USER_TOKEN, "U456", "T999"))).toEqual({
        state: "broken",
        detail: "token is for team T123, not T999",
        fix: FIX,
      });
      expect(yield* read(signedIn("xoxb-bot-opaque-secret", "U234", "T123"))).toEqual({
        state: "broken",
        detail: "token is a bot's",
        fix: FIX,
      });
      expect(yield* read(`SLACK_USER_TOKEN=${USER_TOKEN}\nSLACK_USER_ID=U456\n`)).toMatchObject({
        state: "broken",
        detail: expect.stringContaining("lacks the token, user or team"),
      });
      fake.refuse("token_expired");
      expect(yield* read(signedIn(USER_TOKEN, "U456", "T123"))).toEqual({
        state: "broken",
        detail: "Slack auth.test: token_expired",
        fix: FIX,
      });
    }),
  ));

test("the user token is handed back only once Slack says it is the expected human's", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeSlack();
      const api = (token: string) => slackApi(token, fake.client);
      const token = (lines: string | null, bot?: string) =>
        Effect.flatMap(machine(lines, bot), (env) => slackUserToken(env, api).pipe(Effect.result));

      expect(yield* token(signedIn(USER_TOKEN, "U456", "T123"))).toEqual(
        expect.objectContaining({ _tag: "Success", success: USER_TOKEN }),
      );
      for (const [lines, reason] of [
        [signedIn(USER_TOKEN, "U999", "T123"), "token belongs to U456, not U999"],
        [signedIn(USER_TOKEN, "U456", "T999"), "token is for team T123, not T999"],
        [signedIn("xoxb-bot-opaque-secret", "U234", "T123"), "token is a bot's"],
      ] as const)
        expect(yield* token(lines)).toEqual(
          expect.objectContaining({ _tag: "Failure", failure: reason }),
        );
      expect(yield* token(null, "xoxb-bot-opaque-secret")).toEqual(
        expect.objectContaining({
          _tag: "Failure",
          failure: "Not signed in to Slack as yourself on this Machine",
        }),
      );
      fake.refuse("invalid_auth");
      expect(yield* token(signedIn(USER_TOKEN, "U456", "T123"))).toEqual(
        expect.objectContaining({ _tag: "Failure", failure: "Slack auth.test: invalid_auth" }),
      );
    }),
  ));

test("Slack's rotating access and refresh tokens are redacted whole", () => {
  // Joined here so the forge's secret scanning does not take them for real tokens.
  const refresh = "xoxe-1" + "-My0xLTEyMzQ1Ni1yZWZyZXNoLXRva2Vu";
  const access = "xoxe.xoxp-1" + "-Mi0yLTEyMzQ1Ni1hY2Nlc3MtdG9rZW4";
  expect(redact(`refresh ${refresh} then ${access}.`)).toBe(
    "refresh <slack token> then <slack token>.",
  );
});
