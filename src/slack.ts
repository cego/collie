import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Effect, Option, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { redact } from "./redact";

export const SlackIdentity = Schema.Struct({
  team: Schema.String,
  user: Schema.String,
  team_id: Schema.String,
  user_id: Schema.String,
  bot_id: Schema.String,
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
export const SlackPerson = Schema.Struct({ id: Schema.String, name: Schema.String });
const People = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      deleted: Schema.Boolean,
      is_bot: Schema.Boolean,
      is_app_user: Schema.optionalKey(Schema.Boolean),
      profile: Schema.Struct({
        display_name: Schema.optionalKey(Schema.String),
        real_name: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
  ...Cursor,
});
export const SlackChoices = Schema.Struct({
  identity: SlackIdentity,
  channels: Schema.Array(SlackChannel),
  people: Schema.Array(SlackPerson),
});
export type SlackChoices = typeof SlackChoices.Type;

export const slackText = (text: string) =>
  pipe_(
    text,
    Str.replaceAll("&", "&amp;"),
    Str.replaceAll("<", "&lt;"),
    Str.replaceAll(">", "&gt;"),
  );

export const slackApi = (token: string, client?: HttpClient.HttpClient) => {
  const safe = (message: string) => redact(Arr.join(Str.split(message, token), "<redacted>"));
  const call = <S extends Schema.Decoder<unknown>>(
    method: string,
    schema: S,
    parameters: Record<string, string> = {},
  ): Effect.Effect<S["Type"], string> =>
    Effect.gen(function* () {
      const url = `https://slack.com/api/${method}`;
      const request = (
        ["conversations.list", "users.list", "chat.getPermalink"].includes(method)
          ? HttpClientRequest.get(url).pipe(HttpClientRequest.setUrlParams(parameters))
          : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(parameters))
      ).pipe(HttpClientRequest.bearerToken(token));
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
  return {
    auth: () => call("auth.test", SlackIdentity),
    open: (user: string) =>
      call("conversations.open", Schema.Struct({ channel: Schema.Struct({ id: Schema.String }) }), {
        users: user,
      }).pipe(Effect.map((answer) => answer.channel.id)),
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
    people: () =>
      Effect.gen(function* () {
        const people: Array<typeof SlackPerson.Type> = [];
        let cursor = "";
        const seen = new Set<string>();
        do {
          const parameters = { limit: "200", cursor };
          const page = yield* call("users.list", People, parameters);
          people.push(
            ...Arr.map(
              Arr.filter(
                page.members,
                (person) =>
                  !person.deleted &&
                  !person.is_bot &&
                  !person.is_app_user &&
                  person.id !== "USLACKBOT",
              ),
              (person) => ({
                id: person.id,
                name: person.profile.display_name || person.profile.real_name || person.name,
              }),
            ),
          );
          cursor =
            Option.getOrUndefined(
              Option.flatMap(Option.fromNullishOr(page.response_metadata), (present) =>
                Option.map(Option.fromNullishOr(present.next_cursor), (present_) =>
                  Str.trim(present_),
                ),
              ),
            ) ?? "";
          if (cursor && seen.has(cursor))
            return yield* Effect.fail("Slack users.list repeated its cursor; try again");
          seen.add(cursor);
        } while (cursor);
        return people;
      }),
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
