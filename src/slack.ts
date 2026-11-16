import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Effect, Option, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { redact } from "./redact";

export const SLACK_USER_SCOPES = [
  "chat:write",
  "channels:read",
  "groups:read",
  "reactions:write",
  "reactions:read",
  "channels:history",
  "groups:history",
  "search:read",
];
export const missingSlackScopes = (scopes: string) =>
  Arr.filter(SLACK_USER_SCOPES, (scope) => !Str.split(scopes, ",").includes(scope));
const Message = Schema.Struct({
  ts: Schema.String,
  text: Schema.String,
  thread_ts: Schema.optionalKey(Schema.String),
  reactions: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, users: Schema.Array(Schema.String) })),
  ),
});
export const slackMessageRef = (link: string) => {
  const match =
    /^https:\/\/[^/]+\.slack\.com\/archives\/([CG][A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?.*)?$/.exec(
      Str.trim(link),
    );
  return match ? { channel: match[1]!, ts: `${match[2]}.${match[3]}` } : null;
};

const SlackTokenOwner = Schema.Struct({
  team: Schema.String,
  user: Schema.String,
  team_id: Schema.String,
  user_id: Schema.String,
  bot_id: Schema.optionalKey(Schema.String),
  url: Schema.String,
});
export const SlackChannel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  is_private: Schema.Boolean,
});
const Cursor = {
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
  ),
};
const Channels = Schema.Struct({
  channels: Schema.Array(
    Schema.Struct({ ...SlackChannel.fields, is_member: Schema.optionalKey(Schema.Boolean) }),
  ),
  ...Cursor,
});
/** A person (`U`, `W`) or a direct message (`D`): the human's sign-in cannot open or reach one. */
export const isDirectMessage = (destination: string) => /^[DUW][A-Z0-9]+$/.test(destination);

export const slackText = (text: string) =>
  pipe_(
    text,
    Str.replaceAll("&", "&amp;"),
    Str.replaceAll("<", "&lt;"),
    Str.replaceAll(">", "&gt;"),
  );

const OAuthTokens = {
  access_token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
  scope: Schema.optionalKey(Schema.String),
  token_type: Schema.optionalKey(Schema.String),
};
/** `oauth.v2.access`: a user's tokens under `authed_user`, or at the top for a renewal. */
export const SlackOAuthAnswer = Schema.Struct({
  ...OAuthTokens,
  authed_user: Schema.optionalKey(Schema.Struct({ id: Schema.String, ...OAuthTokens })),
});

const slackCall = (token: string | null, client?: HttpClient.HttpClient) => {
  const safe = (message: string) =>
    redact(token === null ? message : Arr.join(Str.split(message, token), "<redacted>"));
  const call = <S extends Schema.Decoder<unknown>>(
    method: string,
    schema: S,
    parameters: Record<string, string> = {},
  ): Effect.Effect<S["Type"], string> =>
    Effect.gen(function* () {
      const url = `https://slack.com/api/${method}`;
      const request = (
        [
          "conversations.list",
          "chat.getPermalink",
          "conversations.history",
          "search.messages",
          "reactions.get",
        ].includes(method)
          ? HttpClientRequest.get(url).pipe(HttpClientRequest.setUrlParams(parameters))
          : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(parameters))
      ).pipe((request) =>
        token === null ? request : HttpClientRequest.bearerToken(request, token),
      );
      const response = yield* (
        client === undefined
          ? HttpClient.execute(request).pipe(Effect.provide(FetchHttpClient.layer))
          : client.execute(request)
      ).pipe(Effect.mapError(() => `Slack ${method} could not be reached`));
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.fail(`Slack ${method}: HTTP ${response.status}`);
      const json = yield* response.json.pipe(
        Effect.mapError(() => `Slack ${method} returned an unreadable answer`),
      );
      const status = Schema.decodeUnknownOption(
        Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) }),
      )(json);
      if (Option.isNone(status))
        return yield* Effect.fail(`Slack ${method} returned an unreadable answer`);
      if (!status.value.ok)
        return yield* Effect.fail(safe(`Slack ${method}: ${status.value.error ?? "refused"}`));
      const decoded = Schema.decodeOption(schema)(json);
      return Option.isSome(decoded)
        ? decoded.value
        : yield* Effect.fail(`Slack ${method} returned an unreadable answer`);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(`Slack ${method} did not answer; try again`),
      }),
    );
  return call;
};

/** Slack's token exchange and renewal, which no token authorizes. */
export const slackOAuth = (parameters: Record<string, string>, client?: HttpClient.HttpClient) =>
  slackCall(null, client)("oauth.v2.access", SlackOAuthAnswer, parameters);

export const slackApi = (token: string, client?: HttpClient.HttpClient) => {
  const call = slackCall(token, client);
  return {
    tokenOwner: () => call("auth.test", SlackTokenOwner),
    message: (channel: string, ts: string) =>
      call("conversations.history", Schema.Struct({ messages: Schema.Array(Message) }), {
        channel,
        oldest: ts,
        latest: ts,
        inclusive: "true",
        limit: "1",
      }).pipe(
        Effect.flatMap((answer) => {
          const message = Option.getOrUndefined(
            Arr.findFirst(answer.messages, (one) => one.ts === ts),
          );
          return message === undefined
            ? Effect.fail("Slack message was not found")
            : Effect.succeed(message);
        }),
      ),
    search: (query: string) =>
      Effect.gen(function* () {
        const matches: Array<{ channel: string; ts: string; text: string; thread_ts?: string }> =
          [];
        let page = 1;
        let pages = 1;
        do {
          const answer = yield* call(
            "search.messages",
            Schema.Struct({
              messages: Schema.Struct({
                paging: Schema.Struct({ pages: Schema.Finite }),
                matches: Schema.Array(
                  Schema.Struct({
                    ...Message.fields,
                    channel: Schema.Struct({ id: Schema.String }),
                  }),
                ),
              }),
            }),
            { query, count: "100", page: String(page), highlight: "false" },
          );
          matches.push(
            ...Arr.map(answer.messages.matches, (one) => ({ ...one, channel: one.channel.id })),
          );
          pages = answer.messages.paging.pages;
        } while (++page <= pages);
        return matches;
      }),
    reconcile: (channel: string, ts: string, wanted: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const owner = yield* call("auth.test", SlackTokenOwner);
        const got = yield* call("reactions.get", Schema.Struct({ message: Message }), {
          channel,
          timestamp: ts,
          full: "true",
        });
        for (const name of wanted) {
          if (
            Arr.some(
              got.message.reactions ?? [],
              (one) => one.name === name && one.users.includes(owner.user_id),
            )
          )
            continue;
          yield* call("reactions.add", Schema.Struct({}), { channel, timestamp: ts, name }).pipe(
            Effect.catchIf(
              (reason) => reason === "Slack reactions.add: already_reacted",
              () => Effect.succeed({}),
            ),
          );
        }
      }),
    post: (channel: string, text: string) =>
      call("chat.postMessage", Schema.Struct({ channel: Schema.String, ts: Schema.String }), {
        channel,
        text,
      }),
    permalink: (channel: string, ts: string) =>
      call("chat.getPermalink", Schema.Struct({ permalink: Schema.String }), {
        channel,
        message_ts: ts,
      }).pipe(Effect.map((answer) => answer.permalink)),
    channels: () =>
      Effect.gen(function* () {
        const channels: Array<typeof SlackChannel.Type> = [];
        let cursor = "";
        const seen = new Set<string>();
        do {
          const parameters = {
            types: "public_channel,private_channel",
            exclude_archived: "true",
            limit: "200",
            cursor,
          };
          const page = yield* call("conversations.list", Channels, parameters);
          channels.push(
            ...Arr.map(
              Arr.filter(page.channels, (channel) => channel.is_member === true),
              ({ id, name, is_private }) => ({ id, name, is_private }),
            ),
          );
          cursor =
            Option.getOrUndefined(
              Option.flatMap(Option.fromNullishOr(page.response_metadata), (present__) =>
                Option.map(Option.fromNullishOr(present__.next_cursor), (present___) =>
                  Str.trim(present___),
                ),
              ),
            ) ?? "";
          if (cursor && seen.has(cursor))
            return yield* Effect.fail("Slack conversations.list repeated its cursor; try again");
          seen.add(cursor);
        } while (cursor);
        return channels;
      }),
  };
};
