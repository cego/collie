import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Deferred, Effect, Fiber, FileSystem, Order, Queue, Schema, Stream } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { TestClock } from "effect/testing";
import {
  SIGN_IN_EXPIRED,
  SlackUserGrant,
  pkceChallenge,
  slackAuthorizeUrl,
  slackUserSession,
} from "../desktop/src/bun/slack-user";
import { credentialsFile, giveSlackUser } from "../desktop/src/bun/credentials";
import type { Keyring } from "../desktop/src/bun/credentials";
import { fingerprint, givenCredentials } from "../desktop/src/bun/given";
import { localRoute } from "../desktop/src/bun/machine";
import { ranWith } from "../desktop/src/bun/onboarding";
import { SLACK_CALLBACK_PORT } from "../desktop/src/shared/slack";
import type { SlackUserState } from "../desktop/src/shared/flock";
import { slackApi } from "../src/slack";
import { probeSlack } from "../src/slack-credentials";
import { fakeSlack } from "./support/slack";
import { runEffect } from "./support/effect";

const SIGNED_IN = (n: number) =>
  `SLACK_USER_TOKEN=xoxe.xoxp-1-access-${n}\nSLACK_USER_ID=U456\nSLACK_TEAM_ID=T123\nSLACK_USER_SCOPES=chat:write,channels:read,groups:read,reactions:write,reactions:read,channels:history,groups:history,search:read\n`;

const desktop = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-slack-user-" });
  const fake = fakeSlack();
  const stored = credentialsFile(`${dir}/desktop`, `${dir}/no-keyring`);
  let pause: {
    readonly reached: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null = null;
  const pauseGrantLookup = Effect.gen(function* () {
    const held = { reached: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
    pause = held;
    return held;
  });
  const keyring: Keyring = {
    ...stored,
    lookup: (key) =>
      Effect.tap(stored.lookup(key), () => {
        const now = pause;
        if (key !== "slack-user-grant" || now === null) {
          return Effect.void;
        }
        pause = null;
        return Deferred.succeed(now.reached, undefined).pipe(
          Effect.andThen(Deferred.await(now.release)),
        );
      }),
  };
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
      slack: (route, text) =>
        giveSlackUser([route], text).pipe(Effect.map((all) => all[0]!.failed)),
    },
  });
  const opened: Array<URL> = [];
  const browser = {
    answer: (authorize: URL) => {
      const returned: Array<[string, string]> = [
        ["code", "the-code"],
        ["state", authorize.searchParams.get("state")!],
      ];
      return returned;
    },
  };
  const session = yield* slackUserSession({
    keyring,
    give: (text) => given.giveEvery(routes, "slack", text),
    retireBot: stored.forgetSlackBot,
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
  const held = Effect.forEach(["vm", "mini"], (name) =>
    fs.readFileString(file(name, "slack-user.env")).pipe(Effect.orElseSucceed(() => null)),
  );
  const oauthCalls = () => Arr.filter(fake.calls, (call) => call.method === "oauth.v2.access");
  return {
    dir,
    keyring,
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
    pauseGrantLookup,
  };
});

test("the authorize URL asks for posting, reading and reaction user scopes, with an S256 challenge", () => {
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const url = new URL(slackAuthorizeUrl("123.456", "a-state", "a-challenge"));
  expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
  expect(url.searchParams.get("client_id")).toBe("123.456");
  expect(url.searchParams.get("user_scope")).toBe(
    "chat:write,channels:read,groups:read,reactions:write,reactions:read,channels:history,groups:history,search:read",
  );
  expect(url.searchParams.has("scope")).toBe(false);
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:47328/slack/callback");
  expect(url.searchParams.get("state")).toBe("a-state");
  expect(url.searchParams.get("code_challenge")).toBe("a-challenge");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});

test("Desktop asks for re-sign-in when a stored Slack grant lacks follow-through scopes", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      yield* app.session.signIn;
      const raw = yield* app.keyring.lookup("slack-user-grant");
      const grant = yield* Schema.decodeEffect(Schema.fromJsonString(SlackUserGrant))(raw!);
      const legacy = yield* Schema.encodeEffect(Schema.fromJsonString(SlackUserGrant))({
        ...grant,
        scopes: "chat:write,channels:read,groups:read",
      });
      yield* app.keyring.store("slack-user-grant", "Old sign-in", legacy);
      expect((yield* app.session.state).trouble).toContain("sign in again");
    }),
  ));

test("a sign-in keeps nothing and gives nothing unless Slack's answer is the human's own user token", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      const refused = (reason: string) =>
        Effect.gen(function* () {
          expect(yield* app.session.signIn.pipe(Effect.flip)).toBe(reason);
          expect((yield* app.session.state).signedIn).toBeNull();
          expect(yield* app.held).toEqual([null, null]);
        });

      app.browser.answer = () => [
        ["code", "the-code"],
        ["state", "someone-else's"],
      ];
      yield* refused("Slack's answer was not for this sign-in, so nothing was kept");
      app.browser.answer = (authorize) => [
        ["error", "access_denied"],
        ["state", authorize.searchParams.get("state")!],
      ];
      yield* refused("Slack sign-in was cancelled");
      expect(app.oauthCalls()).toEqual([]);
      app.browser.answer = (authorize) => [
        ["code", "the-code"],
        ["state", authorize.searchParams.get("state")!],
      ];
      app.fake.exchange({
        authed_user: {
          id: "U456",
          scope: "channels:read,groups:read",
          access_token: "xoxe.xoxp-1-narrow",
          refresh_token: "xoxe-1-narrow",
          expires_in: 43_200,
        },
      });
      yield* refused(
        "Slack did not grant chat:write, so nothing was kept; sign in again and allow it",
      );
      app.fake.exchange({ access_token: "xoxb-bot-opaque", token_type: "bot" });
      yield* refused("Slack's answer carried a bot token, so nothing was kept");
      app.fake.exchange({
        authed_user: {
          id: "U999",
          scope: "chat:write,channels:read,groups:read",
          access_token: "xoxe.xoxp-1-other",
          refresh_token: "xoxe-1-other",
          expires_in: 43_200,
        },
      });
      yield* refused("Slack says the token is U456's, not U999's, so nothing was kept");

      app.fake.exchange({});
      app.fake.calls.length = 0;
      const signed = yield* app.session.signIn;
      expect(signed.given).toEqual([
        { name: "vm", failed: null },
        { name: "mini", failed: null },
      ]);
      expect(yield* app.session.state).toEqual({
        signedIn: { user: "sam", team: "Example Co" },
        trouble: null,
      });
      const [exchange] = app.oauthCalls();
      expect(Arr.sort(Rec.keys(exchange!.parameters), Order.String)).toEqual([
        "client_id",
        "code",
        "code_verifier",
        "redirect_uri",
      ]);
      expect(exchange!.parameters).toMatchObject({
        client_id: "2673706937.12461393591409",
        code: "the-code",
        redirect_uri: "http://localhost:47328/slack/callback",
      });
      expect(pkceChallenge(exchange!.parameters.code_verifier!)).toBe(
        app.opened.at(-1)!.searchParams.get("code_challenge")!,
      );
      expect(yield* app.held).toEqual([SIGNED_IN(4), SIGNED_IN(4)]);
      const fs = yield* FileSystem.FileSystem;
      expect((yield* fs.stat(app.file("mini", "slack-user.env"))).mode & 0o777).toBe(0o600);
      expect(
        yield* probeSlack({ home: `${app.dir}/vm`, raw: {} }, (token) =>
          slackApi(token, app.fake.client),
        ),
      ).toEqual({
        state: "ok",
        account: "Example Co",
        detail: "Posts as sam in Example Co",
      });
    }),
  ));

test("a sign-in refuses, naming the port, when its callback port is taken", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      const holder = Bun.serve({
        hostname: "127.0.0.1",
        port: SLACK_CALLBACK_PORT,
        fetch: () => new Response(""),
      });
      const failed = yield* app.session.signIn.pipe(Effect.flip);
      yield* Effect.promise(() => holder.stop(true));
      expect(failed).toContain(`Port ${SLACK_CALLBACK_PORT} is in use`);
      expect(app.opened).toEqual([]);
    }),
  ));

test("Desktop renews in the access token's last hour, once at a time, and keeps the old grant when Slack refuses", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      yield* app.session.signIn;
      app.fake.calls.length = 0;

      yield* TestClock.adjust("10 hours");
      expect(yield* app.session.renew(false)).toBeNull();
      expect(app.oauthCalls()).toEqual([]);

      yield* TestClock.adjust("90 minutes");
      expect(yield* app.session.renew(false)).toEqual([
        { name: "vm", failed: null },
        { name: "mini", failed: null },
      ]);
      expect(Arr.map(app.oauthCalls(), (call) => call.parameters)).toEqual([
        {
          client_id: "2673706937.12461393591409",
          grant_type: "refresh_token",
          refresh_token: "xoxe-1-refresh-1",
        },
      ]);
      expect(yield* app.held).toEqual([SIGNED_IN(2), SIGNED_IN(2)]);

      yield* Effect.all([app.session.renew(true), app.session.renew(true)], {
        concurrency: "unbounded",
      });
      expect(Arr.map(app.oauthCalls(), (call) => call.parameters.refresh_token)).toEqual([
        "xoxe-1-refresh-1",
        "xoxe-1-refresh-2",
      ]);
      expect(yield* app.held).toEqual([SIGNED_IN(3), SIGNED_IN(3)]);

      app.fake.refuse("invalid_refresh_token", "oauth.v2.access");
      expect(yield* app.session.renew(true).pipe(Effect.flip)).toBe(
        "Slack oauth.v2.access: invalid_refresh_token",
      );
      expect(yield* app.session.state).toMatchObject({
        signedIn: { user: "sam", team: "Example Co" },
        trouble: SIGN_IN_EXPIRED,
      });
      expect(yield* app.held).toEqual([SIGNED_IN(3), SIGNED_IN(3)]);
      app.fake.refuse(null);
      yield* app.session.renew(false);
      expect(app.oauthCalls().at(-1)!.parameters.refresh_token).toBe("xoxe-1-refresh-3");
      expect((yield* app.session.state).trouble).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("Sign out removes slack-user.env everywhere, even from a Machine that reconnects later", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      yield* app.session.signIn;
      app.reachable.delete("mini");
      yield* app.session.signOut;
      expect(yield* app.held).toEqual([null, SIGNED_IN(1)]);
      app.reachable.add("mini");
      yield* app.given.giveLacking(app.routes[1]!);
      expect(yield* app.held).toEqual([null, null]);
      expect(yield* app.session.state).toMatchObject({ signedIn: null });
    }),
  ));

test("one click signs in to Collie's public Slack app, and a grant kept from another app keeps its own", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      yield* app.session.signIn;
      expect(app.opened.at(-1)!.searchParams.get("client_id")).toBe("2673706937.12461393591409");
      for (const call of app.fake.calls) {
        expect(call.parameters).not.toHaveProperty("client_secret");
      }
      for (const url of app.opened) {
        expect(url.searchParams.has("client_secret")).toBe(false);
      }

      const kept = yield* Schema.encodeEffect(Schema.fromJsonString(SlackUserGrant))({
        clientId: "123.456",
        accessToken: "xoxe.xoxp-1-kept",
        refreshToken: "xoxe-1-kept",
        expiresAt: 0,
        userId: "U456",
        userName: "sam",
        teamId: "T123",
        teamName: "Example Co",
        scopes: "chat:write,channels:read,groups:read",
      });
      yield* app.keyring.store("slack-user-grant", "Slack sign-in", kept);
      yield* app.session.renew(true);
      expect(app.oauthCalls().at(-1)!.parameters).toMatchObject({
        client_id: "123.456",
        refresh_token: "xoxe-1-kept",
      });
      yield* app.session.signIn;
      expect(app.opened.at(-1)!.searchParams.get("client_id")).toBe("123.456");
    }),
  ));

test("an older Collie's bot token stays until the human signs in, then leaves every Machine and Desktop", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      const fs = yield* FileSystem.FileSystem;
      for (const name of ["vm", "mini"]) {
        yield* fs.makeDirectory(`${app.dir}/${name}/.config/collie`, { recursive: true });
        yield* fs.writeFileString(app.file(name, "slack.env"), "SLACK_BOT_TOKEN=xoxb-bot-opaque\n");
      }
      const kept = `${app.dir}/desktop/credentials`;
      yield* fs.makeDirectory(`${app.dir}/desktop`, { recursive: true });
      yield* fs.writeFileString(kept, "gitlab-token=glpat-kept\nslack-token=xoxb-bot-opaque\n");
      yield* app.given.giveLacking(app.routes[0]!);
      expect(yield* fs.exists(app.file("vm", "slack.env"))).toBe(true);

      app.reachable.delete("mini");
      yield* app.session.signIn;
      expect(yield* fs.exists(app.file("vm", "slack.env"))).toBe(false);
      expect(yield* fs.exists(app.file("mini", "slack.env"))).toBe(true);
      expect(yield* fs.readFileString(kept)).not.toContain("xoxb-bot-opaque");
      expect(yield* app.keyring.lookup("gitlab-token")).toBe("glpat-kept");
      app.reachable.add("mini");
      yield* app.given.giveLacking(app.routes[1]!);
      expect(yield* fs.exists(app.file("mini", "slack.env"))).toBe(false);
      expect(yield* app.held).toEqual([SIGNED_IN(1), SIGNED_IN(1)]);
    }),
  ));

const reopen = (app: Effect.Success<typeof desktop>) =>
  givenCredentials({
    dir: `${app.dir}/given`,
    keyring: app.keyring,
    skipped: () => Effect.succeed([]),
    tell: () => Effect.void,
    give: {
      gitlab: () => Effect.succeed(null),
      helle: () => Effect.succeed(null),
      slack: (route, text) =>
        giveSlackUser([route], text).pipe(Effect.map((all) => all[0]!.failed)),
    },
  });

test("a Machine given the sign-in is not given it again once Desktop reopens", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      yield* app.session.signIn;
      const desktop2 = yield* reopen(app);
      expect(yield* desktop2.giveLacking(app.routes[1]!)).toEqual([]);
    }),
  ));

test("a Machine an older Desktop gave the sign-in is not given it again, and a later sign-out still reaches it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      yield* app.session.signIn;
      const fs = yield* FileSystem.FileSystem;
      const signIn = fingerprint((yield* app.keyring.lookup("slack-user-grant"))!);
      // WARNING: An older Desktop recorded the bot's removal as slack and the sign-in as slack-user.
      const older = `{"slack":"${fingerprint("")}","slack-user":"${signIn}"}`;
      yield* fs.writeFileString(`${app.dir}/given/given.json`, `{"vm":${older},"mini":${older}}`);
      const desktop2 = yield* reopen(app);
      expect(yield* desktop2.giveLacking(app.routes[1]!)).toEqual([]);
      yield* app.keyring.store("slack-user-grant", "Slack signed out", "");
      expect(yield* desktop2.giveLacking(app.routes[1]!)).toEqual([
        { credential: "slack", failed: null },
      ]);
      expect(yield* app.held).toEqual([SIGNED_IN(1), null]);
    }),
  ));

test("a refused exchange or renewal never says the access or refresh token", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      app.fake.refuse("invalid_auth xoxe.xoxp-1-access-1 xoxe-1-refresh-1", "auth.test");
      const exchange = yield* app.session.signIn.pipe(Effect.flip);
      expect(exchange).toStartWith("Slack auth.test: invalid_auth");
      app.fake.refuse(null);
      yield* app.session.signIn;
      app.fake.refuse(
        "invalid_refresh_token xoxe-1-refresh-2 xoxe.xoxp-1-access-2",
        "oauth.v2.access",
      );
      const renewal = yield* app.session.renew(true).pipe(Effect.flip);
      expect(renewal).toStartWith("Slack oauth.v2.access: invalid_refresh_token");
      for (const said of [exchange, renewal]) {
        for (const token of [
          "xoxe.xoxp-1-access-1",
          "xoxe-1-refresh-1",
          "xoxe.xoxp-1-access-2",
          "xoxe-1-refresh-2",
        ]) {
          expect(said).not.toContain(token);
        }
      }
    }),
  ));

test("Desktop lists the channels the human is in with their own token, renewing it first once it has expired", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      expect(yield* app.session.channels.pipe(Effect.flip)).toBe(
        "Sign in to Slack under Connections to pick a channel you're in",
      );
      yield* app.session.signIn;
      app.fake.calls.length = 0;
      app.fake.authorized.length = 0;
      expect(yield* app.session.channels).toEqual([
        { id: "C456", name: "design", is_private: false },
        { id: "G234", name: "releases", is_private: true },
      ]);
      expect(app.fake.authorized).toEqual([
        { method: "conversations.list", by: "user" },
        { method: "conversations.list", by: "user" },
      ]);

      yield* TestClock.adjust("13 hours");
      app.fake.calls.length = 0;
      expect(yield* app.session.channels).toHaveLength(2);
      expect(Arr.map(app.fake.calls, (call) => call.method)).toEqual([
        "oauth.v2.access",
        "conversations.list",
        "conversations.list",
      ]);
      expect(yield* app.held).toEqual([SIGNED_IN(2), SIGNED_IN(2)]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a Machine connecting while the human signs out is not given the grant they signed out of", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      app.reachable.delete("mini");
      yield* app.session.signIn;
      expect(yield* app.held).toEqual([SIGNED_IN(1), null]);
      app.reachable.add("mini");
      const paused = yield* app.pauseGrantLookup;
      const reconnect = yield* Effect.forkScoped(app.given.giveLacking(app.routes[1]!));
      yield* Deferred.await(paused.reached);
      yield* app.session.signOut;
      yield* Deferred.succeed(paused.release, undefined);
      yield* Fiber.join(reconnect);
      expect(yield* app.held).toEqual([null, null]);
    }),
  ));

test("the sign-in's standing is told again as it changes, a renewal refused in the background included", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* desktop;
      yield* app.session.signIn;
      const told = yield* Queue.unbounded<typeof SlackUserState.Type>();
      yield* app.session.changes.pipe(
        Stream.runForEach((state) => Queue.offer(told, state)),
        Effect.forkScoped,
      );
      const next = Queue.take(told).pipe(Effect.timeout("2 seconds"));
      const sam = { user: "sam", team: "Example Co" };
      expect(yield* next).toEqual({ signedIn: sam, trouble: null });
      app.fake.refuse("invalid_refresh_token", "oauth.v2.access");
      yield* app.session.renew(true).pipe(Effect.flip);
      expect(yield* next).toEqual({ signedIn: sam, trouble: SIGN_IN_EXPIRED });
      yield* app.session.signOut;
      expect(yield* next).toEqual({ signedIn: null, trouble: null });
    }),
  ));
