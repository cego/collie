// The human signed in to Slack as themselves: OAuth with PKCE and no client secret, the
// grant kept by Desktop and renewed while it runs, and each Machine given the access token.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Clock, Deferred, Duration, Effect, Option, Schema, Semaphore } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import { slackApi, slackOAuth, type SlackOAuthAnswer } from "../../../src/slack";
import { redact } from "../../../src/redact";
import {
  SLACK_CALLBACK_PATH,
  SLACK_CALLBACK_PORT,
  SLACK_REDIRECT_URL,
  SLACK_USER_SCOPES,
  SIGN_IN_TO_PICK,
} from "../shared/slack";
import type { Keyring } from "./credentials";

export const SlackUserGrant = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  /** Epoch milliseconds. */
  expiresAt: Schema.Finite,
  userId: Schema.String,
  userName: Schema.String,
  teamId: Schema.String,
  teamName: Schema.String,
  scopes: Schema.String,
});
export type SlackUserGrant = typeof SlackUserGrant.Type;
const GrantJson = Schema.fromJsonString(SlackUserGrant);

/** The `slack-user.env` lines `probeSlackUser` checks. */
export const slackUserLines = (grant: SlackUserGrant) =>
  `SLACK_USER_TOKEN=${grant.accessToken}\nSLACK_USER_ID=${grant.userId}\nSLACK_TEAM_ID=${grant.teamId}\n`;

export const decodeGrant = (text: string) => Option.getOrNull(Schema.decodeOption(GrantJson)(text));

export const SIGN_IN_EXPIRED = "Slack sign-in expired: sign in again";
const RENEW_BEFORE = Duration.hours(1);
const CALLBACK_LIMIT = "5 minutes";

export const pkceChallenge = (verifier: string) =>
  Base64Url.encode(new Bun.CryptoHasher("sha256").update(verifier).digest());
const secret = () => Base64Url.encode(SecureRandom.randomBytesUnsafe(32));

export const slackAuthorizeUrl = (clientId: string, state: string, challenge: string) =>
  `https://slack.com/oauth/v2/authorize?${new URLSearchParams({
    client_id: clientId,
    user_scope: Arr.join(SLACK_USER_SCOPES, ","),
    redirect_uri: SLACK_REDIRECT_URL,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;

type Given = ReadonlyArray<{ readonly name: string; readonly failed: string | null }>;

/** The user's tokens in an answer, wherever Slack put them. */
const userTokens = (answer: typeof SlackOAuthAnswer.Type) => {
  const tokens = answer.authed_user ?? (answer.token_type === "user" ? answer : undefined);
  return tokens?.access_token !== undefined &&
    tokens.refresh_token !== undefined &&
    tokens.expires_in !== undefined
    ? {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope ?? "",
      }
    : null;
};

const listen = (state: string, open: (url: string) => Effect.Effect<void>, url: string) =>
  Effect.gen(function* () {
    const arrived = yield* Deferred.make<URLSearchParams>();
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            // A held port refuses here; browsers fall back to it for localhost.
            hostname: "127.0.0.1",
            port: SLACK_CALLBACK_PORT,
            fetch: (request) => {
              const at = new URL(request.url);
              if (at.pathname !== SLACK_CALLBACK_PATH)
                return new Response("Not found", { status: 404 });
              Deferred.doneUnsafe(arrived, Effect.succeed(at.searchParams));
              return new Response(
                "<!doctype html><title>Collie</title><p>You can close this tab.</p>",
                { headers: { "content-type": "text/html; charset=utf-8" } },
              );
            },
          }),
        catch: () =>
          `Port ${SLACK_CALLBACK_PORT} is in use, so Slack cannot answer; close what holds it and sign in again`,
      }),
      (server) => Effect.promise(() => server.stop()),
    );
    yield* open(url);
    const answer = yield* Deferred.await(arrived).pipe(
      Effect.timeoutOrElse({
        duration: CALLBACK_LIMIT,
        orElse: () => Effect.fail("Slack sign-in got no answer within 5 minutes; sign in again"),
      }),
    );
    if (answer.get("state") !== state)
      return yield* Effect.fail("Slack's answer was not for this sign-in, so nothing was kept");
    const error = answer.get("error");
    if (error === "access_denied") return yield* Effect.fail("Slack sign-in was cancelled");
    const code = answer.get("code");
    if (error !== null || code === null)
      return yield* Effect.fail(`Slack sign-in failed: ${error ?? "no code"}`);
    return code;
  }).pipe(Effect.scoped);

export const slackUserSession = (options: {
  readonly keyring: Keyring;
  /** Gives every Machine the grant, or "" to remove it, and says how each went. */
  readonly give: (text: string) => Effect.Effect<Given>;
  readonly open: (url: string) => Effect.Effect<void>;
  readonly client?: HttpClient.HttpClient;
}) => {
  // A refresh token works once, so renewals never overlap.
  const lock = Semaphore.makeUnsafe(1);
  let trouble: string | null = null;
  const kept = options.keyring
    .lookup("slack-user-grant")
    .pipe(Effect.map((text) => (text ? decodeGrant(text) : null)));
  const keep = (grant: SlackUserGrant) =>
    Effect.gen(function* () {
      const text = yield* Schema.encodeEffect(GrantJson)(grant).pipe(
        Effect.mapError(() => "Slack's sign-in could not be kept"),
      );
      yield* options.keyring.store("slack-user-grant", "Slack sign-in as you", text);
      trouble = null;
      return yield* options.give(text);
    });
  const hidden = (grant: SlackUserGrant | null) => (reason: string) =>
    redact(
      Arr.reduce(
        grant === null ? [] : [grant.accessToken, grant.refreshToken],
        reason,
        (said, token) => Arr.join(Str.split(said, token), "<redacted>"),
      ),
    );

  const signIn = (clientId: string) =>
    Effect.gen(function* () {
      const id = Str.trim(clientId) || ((yield* kept)?.clientId ?? "");
      if (id === "")
        return yield* Effect.fail(
          "Paste the Collie app's Client ID, from Basic Information › App Credentials",
        );
      const state = secret();
      const verifier = secret();
      const code = yield* listen(
        state,
        options.open,
        slackAuthorizeUrl(id, state, pkceChallenge(verifier)),
      );
      const answer = yield* slackOAuth(
        { client_id: id, code, code_verifier: verifier, redirect_uri: SLACK_REDIRECT_URL },
        options.client,
      );
      if (answer.access_token !== undefined)
        return yield* Effect.fail("Slack's answer carried a bot token, so nothing was kept");
      const tokens = userTokens(answer);
      if (answer.authed_user === undefined || tokens === null)
        return yield* Effect.fail("Slack's answer had no user token, so nothing was kept");
      if (!Arr.contains(Str.split(tokens.scope, ","), "chat:write"))
        return yield* Effect.fail(
          "Slack did not grant chat:write, so nothing was kept; sign in again and allow it",
        );
      const owner = yield* slackApi(tokens.access, options.client).tokenOwner();
      if (owner.bot_id !== undefined || owner.user_id !== answer.authed_user.id)
        return yield* Effect.fail(
          `Slack says the token is ${owner.user_id}'s, not ${answer.authed_user.id}'s, so nothing was kept`,
        );
      const grant: SlackUserGrant = {
        clientId: id,
        accessToken: tokens.access,
        refreshToken: tokens.refresh,
        expiresAt: (yield* Clock.currentTimeMillis) + tokens.expiresIn * 1000,
        userId: owner.user_id,
        userName: owner.user,
        teamId: owner.team_id,
        teamName: owner.team,
        scopes: tokens.scope,
      };
      return { grant, given: yield* lock.withPermits(1)(keep(grant)) };
    }).pipe(Effect.mapError(hidden(null)));

  /** Renews when less than an hour is left, or now when `now`; null when nothing was due. */
  const renew = (now: boolean) =>
    Effect.gen(function* () {
      const before = yield* kept;
      if (before === null) return null;
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const grant = yield* kept;
          if (grant === null || grant.refreshToken !== before.refreshToken) return null;
          const left = grant.expiresAt - (yield* Clock.currentTimeMillis);
          if (!now && trouble === null && left > Duration.toMillis(RENEW_BEFORE)) return null;
          const tokens = yield* slackOAuth(
            {
              client_id: grant.clientId,
              grant_type: "refresh_token",
              refresh_token: grant.refreshToken,
            },
            options.client,
          ).pipe(
            Effect.map(userTokens),
            Effect.filterOrFail(
              (found) => found !== null,
              () => "Slack's renewal had no user token",
            ),
            Effect.tapError(() =>
              Effect.sync(() => {
                trouble = SIGN_IN_EXPIRED;
              }),
            ),
          );
          return yield* keep({
            ...grant,
            accessToken: tokens.access,
            refreshToken: tokens.refresh,
            expiresAt: (yield* Clock.currentTimeMillis) + tokens.expiresIn * 1000,
            scopes: tokens.scope || grant.scopes,
          });
        }).pipe(Effect.mapError(hidden(before))),
      );
    });

  const channels = Effect.gen(function* () {
    const before = yield* kept;
    if (before === null) return yield* Effect.fail(SIGN_IN_TO_PICK);
    if (before.expiresAt <= (yield* Clock.currentTimeMillis)) yield* renew(true);
    const grant = (yield* kept) ?? before;
    return yield* slackApi(grant.accessToken, options.client)
      .channels()
      .pipe(Effect.mapError(hidden(grant)));
  });

  return {
    /** What the card says; no token. */
    state: Effect.map(kept, (grant) => ({
      signedIn: grant === null ? null : { user: grant.userName, team: grant.teamName },
      clientId: grant?.clientId ?? null,
      trouble,
    })),
    signIn,
    renew,
    channels,
    /** Forgets the grant and removes it from every Machine, those that connect later too. */
    signOut: lock.withPermits(1)(
      Effect.gen(function* () {
        yield* options.keyring.store("slack-user-grant", "Slack signed out", "");
        trouble = null;
        return yield* options.give("");
      }),
    ),
    keepSignedIn: renew(true).pipe(
      Effect.catch((reason) => Effect.logWarning(`Slack sign-in renewal: ${reason}`)),
      Effect.andThen(
        renew(false).pipe(
          Effect.catch((reason) => Effect.logWarning(`Slack sign-in renewal: ${reason}`)),
          Effect.delay("5 minutes"),
          Effect.forever,
        ),
      ),
    ),
  };
};
