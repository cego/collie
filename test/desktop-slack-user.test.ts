import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, FileSystem, Order } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { TestClock } from "effect/testing";
import {
  SIGN_IN_EXPIRED,
  pkceChallenge,
  slackAuthorizeUrl,
  slackUserSession,
} from "../desktop/src/bun/slack-user";
import { credentialsFile, giveSlack, giveSlackUser } from "../desktop/src/bun/credentials";
import { givenCredentials } from "../desktop/src/bun/given";
import { localRoute } from "../desktop/src/bun/machine";
import { ranWith } from "../desktop/src/bun/onboarding";
import { disconnectSlackConnection } from "../desktop/src/bun/slack";
import { SLACK_CALLBACK_PORT } from "../desktop/src/shared/slack";
import { slackApi } from "../src/slack";
import { probeSlackUser } from "../src/slack-credentials";
import { fakeSlack } from "./support/slack";
import { runEffect } from "./support/effect";

const SIGNED_IN = (n: number) =>
  `SLACK_USER_TOKEN=xoxe.xoxp-1-access-${n}\nSLACK_USER_ID=U456\nSLACK_TEAM_ID=T123\n`;

/** Desktop with two Machines, a fake Slack and a browser that answers as `browser` says. */
const desktop = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-slack-user-" });
  const fake = fakeSlack();
  const keyring = credentialsFile(`${dir}/desktop`, `${dir}/no-keyring`);
  const reachable = new Set(["vm", "mini"]);
  const routes = Arr.map(["vm", "mini"], (name) => ({
    ...localRoute([], name),
    machine: { profile: name, name },
    execute: (script: string, stdin?: Uint8Array) =>
      reachable.has(name)
        ? ranWith(["env", `HOME=${dir}/${name}`, "XDG_CONFIG_HOME=", "sh", "-c", script], stdin)
        : Effect.succeed({ code: 1, out: "", err: "unreachable" }),
  }));
  const given = yield* givenCredentials({
    dir: `${dir}/given`,
    keyring,
    skipped: () => Effect.succeed([]),
    tell: () => Effect.void,
    give: {
      gitlab: () => Effect.succeed(null),
      helle: () => Effect.succeed(null),
      slack: (route, text) => giveSlack([route], text).pipe(Effect.map((all) => all[0]!.failed)),
      "slack-user": (route, text) =>
        giveSlackUser([route], text).pipe(Effect.map((all) => all[0]!.failed)),
    },
  });
  const opened: URL[] = [];
  const browser = {
    answer: (authorize: URL): Array<[string, string]> => [
      ["code", "the-code"],
      ["state", authorize.searchParams.get("state")!],
    ],
  };
  const session = slackUserSession({
    keyring,
    give: (text) => given.giveEvery(routes, "slack-user", text),
    open: (url) => {
      const authorize = new URL(url);
      opened.push(authorize);
      return HttpClient.get(
        `${authorize.searchParams.get("redirect_uri")!}?${new URLSearchParams(browser.answer(authorize)).toString()}`,
      ).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie, Effect.asVoid);
    },
    client: fake.client,
  });
  const file = (name: string, which: string) => `${dir}/${name}/.config/collie/${which}`;
  /** What each Machine holds in `slack-user.env`, or null without one. */
  const held = Effect.forEach(["vm", "mini"], (name) =>
    fs
      .readFileString(file(name, "slack-user.env"))
      .pipe(Effect.orElseSucceed((): string | null => null)),
  );
  const oauthCalls = () => Arr.filter(fake.calls, (call) => call.method === "oauth.v2.access");
  return {
    dir,
    fake,
    session,
    given,
    routes,
    reachable,
    browser,
    opened,
    held,
    file,
    oauthCalls,
  };
});

test("the authorize URL asks for the three user scopes only, with an S256 challenge", () => {
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const url = new URL(slackAuthorizeUrl("123.456", "a-state", "a-challenge"));
  expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
  expect(url.searchParams.get("client_id")).toBe("123.456");
  expect(url.searchParams.get("user_scope")).toBe("chat:write,channels:read,groups:read");
  expect(url.searchParams.has("scope")).toBe(false);
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:47328/slack/callback");
  expect(url.searchParams.get("state")).toBe("a-state");
  expect(url.searchParams.get("code_challenge")).toBe("a-challenge");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});

test("a sign-in keeps nothing and gives nothing unless Slack's answer is the human's own user token", () =>
  runEffect(
    Effect.gen(function* () {
      const it = yield* desktop;
      const refused = (reason: string) =>
        Effect.gen(function* () {
          expect(yield* it.session.signIn("123.456").pipe(Effect.flip)).toBe(reason);
          expect((yield* it.session.state).signedIn).toBeNull();
          expect(yield* it.held).toEqual([null, null]);
        });

      expect(yield* it.session.signIn("").pipe(Effect.flip)).toContain("Client ID");
      it.browser.answer = () => [
        ["code", "the-code"],
        ["state", "someone-else's"],
      ];
      yield* refused("Slack's answer was not for this sign-in, so nothing was kept");
      it.browser.answer = (authorize) => [
        ["error", "access_denied"],
        ["state", authorize.searchParams.get("state")!],
      ];
      yield* refused("Slack sign-in was cancelled");
      expect(it.oauthCalls()).toEqual([]);
      it.browser.answer = (authorize) => [
        ["code", "the-code"],
        ["state", authorize.searchParams.get("state")!],
      ];
      it.fake.exchange({
        authed_user: {
          id: "U456",
          scope: "channels:read,groups:read",
          access_token: "xoxe.xoxp-1-narrow",
          refresh_token: "xoxe-1-narrow",
          expires_in: 43200,
        },
      });
      yield* refused(
        "Slack did not grant chat:write, so nothing was kept; sign in again and allow it",
      );
      it.fake.exchange({ access_token: "xoxb-bot-opaque", token_type: "bot" });
      yield* refused("Slack's answer carried a bot token, so nothing was kept");
      it.fake.exchange({
        authed_user: {
          id: "U999",
          scope: "chat:write,channels:read,groups:read",
          access_token: "xoxe.xoxp-1-other",
          refresh_token: "xoxe-1-other",
          expires_in: 43200,
        },
      });
      yield* refused("Slack says the token is U456's, not U999's, so nothing was kept");

      it.fake.exchange({});
      it.fake.calls.length = 0;
      const signed = yield* it.session.signIn("123.456");
      expect(signed.given).toEqual([
        { name: "vm", failed: null },
        { name: "mini", failed: null },
      ]);
      expect(yield* it.session.state).toEqual({
        signedIn: { user: "sam", team: "Example Co" },
        clientId: "123.456",
        trouble: null,
      });
      const [exchange] = it.oauthCalls();
      expect(Arr.sort(Rec.keys(exchange!.parameters), Order.String)).toEqual([
        "client_id",
        "code",
        "code_verifier",
        "redirect_uri",
      ]);
      expect(exchange!.parameters).toMatchObject({
        client_id: "123.456",
        code: "the-code",
        redirect_uri: "http://localhost:47328/slack/callback",
      });
      expect(pkceChallenge(exchange!.parameters.code_verifier!)).toBe(
        it.opened.at(-1)!.searchParams.get("code_challenge")!,
      );
      expect(yield* it.held).toEqual([SIGNED_IN(4), SIGNED_IN(4)]);
      const fs = yield* FileSystem.FileSystem;
      expect((yield* fs.stat(it.file("mini", "slack-user.env"))).mode & 0o777).toBe(0o600);
      expect(
        yield* probeSlackUser({ home: `${it.dir}/vm`, raw: {} }, (token) =>
          slackApi(token, it.fake.client),
        ),
      ).toEqual({
        state: "ok",
        account: "Example Co",
        detail: "Posts approval requests as sam in Example Co",
      });
    }),
  ));

test("a sign-in refuses, naming the port, when its callback port is taken", () =>
  runEffect(
    Effect.gen(function* () {
      const it = yield* desktop;
      const holder = Bun.serve({
        hostname: "127.0.0.1",
        port: SLACK_CALLBACK_PORT,
        fetch: () => new Response(""),
      });
      const failed = yield* it.session.signIn("123.456").pipe(Effect.flip);
      yield* Effect.promise(() => holder.stop(true));
      expect(failed).toContain(`Port ${SLACK_CALLBACK_PORT} is in use`);
      expect(it.opened).toEqual([]);
    }),
  ));

test("Desktop renews in the access token's last hour, once at a time, and keeps the old grant when Slack refuses", () =>
  runEffect(
    Effect.gen(function* () {
      const it = yield* desktop;
      yield* it.session.signIn("123.456");
      it.fake.calls.length = 0;

      yield* TestClock.adjust("10 hours");
      expect(yield* it.session.renew(false)).toBeNull();
      expect(it.oauthCalls()).toEqual([]);

      yield* TestClock.adjust("90 minutes");
      expect(yield* it.session.renew(false)).toEqual([
        { name: "vm", failed: null },
        { name: "mini", failed: null },
      ]);
      expect(Arr.map(it.oauthCalls(), (call) => call.parameters)).toEqual([
        { client_id: "123.456", grant_type: "refresh_token", refresh_token: "xoxe-1-refresh-1" },
      ]);
      expect(yield* it.held).toEqual([SIGNED_IN(2), SIGNED_IN(2)]);

      yield* Effect.all([it.session.renew(true), it.session.renew(true)], {
        concurrency: "unbounded",
      });
      expect(Arr.map(it.oauthCalls(), (call) => call.parameters.refresh_token)).toEqual([
        "xoxe-1-refresh-1",
        "xoxe-1-refresh-2",
      ]);
      expect(yield* it.held).toEqual([SIGNED_IN(3), SIGNED_IN(3)]);

      it.fake.refuse("invalid_refresh_token", "oauth.v2.access");
      expect(yield* it.session.renew(true).pipe(Effect.flip)).toBe(
        "Slack oauth.v2.access: invalid_refresh_token",
      );
      expect(yield* it.session.state).toMatchObject({
        signedIn: { user: "sam", team: "Example Co" },
        trouble: SIGN_IN_EXPIRED,
      });
      expect(yield* it.held).toEqual([SIGNED_IN(3), SIGNED_IN(3)]);
      it.fake.refuse(null);
      yield* it.session.renew(false);
      expect(it.oauthCalls().at(-1)!.parameters.refresh_token).toBe("xoxe-1-refresh-3");
      expect((yield* it.session.state).trouble).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("Sign out removes slack-user.env everywhere, even from a Machine that reconnects later, and leaves the bot; Disconnect leaves the sign-in", () =>
  runEffect(
    Effect.gen(function* () {
      const it = yield* desktop;
      const fs = yield* FileSystem.FileSystem;
      yield* it.given.giveEvery(it.routes, "slack", "xoxb-bot-opaque");
      yield* it.session.signIn("123.456");
      it.reachable.delete("mini");
      yield* it.session.signOut;
      expect(yield* it.held).toEqual([null, SIGNED_IN(1)]);
      it.reachable.add("mini");
      yield* it.given.giveLacking(it.routes[1]!);
      expect(yield* it.held).toEqual([null, null]);
      expect(yield* it.session.state).toMatchObject({ signedIn: null });
      for (const name of ["vm", "mini"])
        expect(yield* fs.readFileString(it.file(name, "slack.env"))).toBe(
          "SLACK_BOT_TOKEN=xoxb-bot-opaque\n",
        );

      yield* it.session.signIn("123.456");
      yield* disconnectSlackConnection(
        credentialsFile(`${it.dir}/desktop`, `${it.dir}/no-keyring`),
        (text) => it.given.giveEvery(it.routes, "slack", text),
      );
      expect(yield* fs.exists(it.file("vm", "slack.env"))).toBe(false);
      expect(yield* it.held).toEqual([SIGNED_IN(2), SIGNED_IN(2)]);
      expect((yield* it.session.state).signedIn).toEqual({ user: "sam", team: "Example Co" });
    }),
  ));

test("a refused exchange or renewal never says the access or refresh token", () =>
  runEffect(
    Effect.gen(function* () {
      const it = yield* desktop;
      it.fake.refuse("invalid_auth xoxe.xoxp-1-access-1 xoxe-1-refresh-1", "auth.test");
      const exchange = yield* it.session.signIn("123.456").pipe(Effect.flip);
      expect(exchange).toStartWith("Slack auth.test: invalid_auth");
      it.fake.refuse(null);
      yield* it.session.signIn("123.456");
      it.fake.refuse(
        "invalid_refresh_token xoxe-1-refresh-2 xoxe.xoxp-1-access-2",
        "oauth.v2.access",
      );
      const renewal = yield* it.session.renew(true).pipe(Effect.flip);
      expect(renewal).toStartWith("Slack oauth.v2.access: invalid_refresh_token");
      for (const said of [exchange, renewal])
        for (const token of [
          "xoxe.xoxp-1-access-1",
          "xoxe-1-refresh-1",
          "xoxe.xoxp-1-access-2",
          "xoxe-1-refresh-2",
        ])
          expect(said).not.toContain(token);
    }),
  ));

test("Desktop lists the channels the human is in with their own token, renewing it first once it has expired", () =>
  runEffect(
    Effect.gen(function* () {
      const it = yield* desktop;
      expect(yield* it.session.channels.pipe(Effect.flip)).toBe(
        "Sign in to Slack as yourself under Connections to pick a channel you're in",
      );
      yield* it.session.signIn("123.456");
      it.fake.calls.length = 0;
      it.fake.authorized.length = 0;
      expect(yield* it.session.channels).toEqual([
        { id: "C456", name: "design", is_private: false },
        { id: "G234", name: "releases", is_private: true },
      ]);
      expect(it.fake.authorized).toEqual([
        { method: "conversations.list", by: "user" },
        { method: "conversations.list", by: "user" },
      ]);

      yield* TestClock.adjust("13 hours");
      it.fake.calls.length = 0;
      expect(yield* it.session.channels).toHaveLength(2);
      expect(Arr.map(it.fake.calls, (call) => call.method)).toEqual([
        "oauth.v2.access",
        "conversations.list",
        "conversations.list",
      ]);
      expect(yield* it.held).toEqual([SIGNED_IN(2), SIGNED_IN(2)]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));
