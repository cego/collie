// Slack's documented Web API envelopes; requests are recorded without their authorization header.
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { Effect, FileSystem, Path, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { SlackOAuthAnswer } from "../../src/slack";
import { slackUserEnvPath } from "../../src/slack-credentials";
import type { PluginEnv } from "../../src/env";

/** The Machine's sign-in as the fake's user U456 in T123, expecting `user`; null removes it. */
export const signedInToSlack = (env: Pick<PluginEnv, "home" | "raw">, user: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = slackUserEnvPath(env);
    if (user === null) return yield* fs.remove(file, { force: true });
    yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true });
    yield* fs.writeFileString(
      file,
      `SLACK_USER_TOKEN=xoxe.xoxp-1-user-fixture\nSLACK_USER_ID=${user}\nSLACK_TEAM_ID=T123\n`,
      { mode: 0o600 },
    );
  }).pipe(Effect.orDie);

/** The `slack.env` an older Collie wrote for its bot, or none for false. */
export const botLeftOver = (env: Pick<PluginEnv, "home" | "raw">, left: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${(yield* Path.Path).dirname(slackUserEnvPath(env))}/slack.env`;
    if (!left) return yield* fs.remove(file, { force: true });
    yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "SLACK_BOT_TOKEN=xoxb-fixture\n", { mode: 0o600 });
  }).pipe(Effect.orDie);

export const fakeSlack = () => {
  const calls: Array<{ method: string; parameters: Record<string, string> }> = [];
  const authorized: Array<{ method: string; by: "bot" | "user" | null }> = [];
  let refused: string | null = null;
  let refusedMethod: string | undefined;
  let issued = 0;
  let exchanged: Partial<typeof SlackOAuthAnswer.Encoded> = {};
  const answer = (
    method: string,
    parameters: Record<string, string>,
    by: "bot" | "user" | null,
  ) => {
    calls.push({ method, parameters });
    authorized.push({ method, by });
    if (method === "oauth.v2.access") {
      if (refused !== null && (refusedMethod === undefined || refusedMethod === method))
        return Response.json({ ok: false, error: refused });
      issued += 1;
      const tokens = {
        access_token: `xoxe.xoxp-1-access-${issued}`,
        refresh_token: `xoxe-1-refresh-${issued}`,
        expires_in: 43200,
        token_type: "user",
        scope: "chat:write,channels:read,groups:read",
      };
      return Response.json(
        parameters.grant_type === "refresh_token"
          ? { ok: true, app_id: "A123", ...tokens }
          : {
              ok: true,
              app_id: "A123",
              team: { id: "T123", name: "Example Co" },
              authed_user: { id: "U456", ...tokens },
              ...exchanged,
            },
      );
    }
    if (by === null) return Response.json({ ok: false, error: "invalid_auth" });
    if (refused !== null && (refusedMethod === undefined || refusedMethod === method))
      return Response.json({ ok: false, error: refused });
    if (method === "auth.test" && by === "user")
      return Response.json({
        ok: true,
        url: "https://example.slack.com/",
        team: "Example Co",
        user: "sam",
        team_id: "T123",
        user_id: "U456",
      });
    if (method === "auth.test")
      return Response.json({
        ok: true,
        url: "https://example.slack.com/",
        team: "Example Co",
        user: "collie",
        team_id: "T123",
        user_id: "U234",
        bot_id: "B345",
      });
    if (method === "conversations.list" && by === "user")
      return Response.json({
        ok: true,
        channels:
          parameters.cursor === "channels-next"
            ? [{ id: "G234", name: "releases", is_member: true, is_private: true }]
            : [
                { id: "C123", name: "engineering", is_member: false, is_private: false },
                { id: "C456", name: "design", is_member: true, is_private: false },
              ],
        response_metadata: { next_cursor: parameters.cursor ? "" : "channels-next" },
      });
    if (method === "conversations.list")
      return Response.json({
        ok: true,
        channels:
          parameters.cursor === "channels-next"
            ? [{ id: "G234", name: "releases", is_member: true, is_private: true }]
            : [
                { id: "C123", name: "engineering", is_member: true, is_private: false },
                { id: "C999", name: "not-joined", is_member: false, is_private: false },
              ],
        response_metadata: { next_cursor: parameters.cursor ? "" : "channels-next" },
      });
    if (method === "users.list")
      return Response.json({
        ok: true,
        members:
          parameters.cursor === "people-next"
            ? [
                {
                  id: "U789",
                  name: "alex",
                  deleted: false,
                  is_bot: false,
                  profile: { display_name: "Alex Example", real_name: "Alex Example" },
                },
                {
                  id: "U999",
                  name: "gone",
                  deleted: true,
                  is_bot: false,
                  profile: { display_name: "Gone" },
                },
              ]
            : [
                {
                  id: "U456",
                  name: "sam",
                  deleted: false,
                  is_bot: false,
                  profile: { display_name: "Sam" },
                },
                {
                  id: "U234",
                  name: "collie",
                  deleted: false,
                  is_bot: true,
                  profile: { display_name: "Collie" },
                },
              ],
        response_metadata: { next_cursor: parameters.cursor ? "" : "people-next" },
      });
    if (method === "conversations.open")
      return Response.json({ ok: true, channel: { id: "D123" } });
    if (method === "chat.postMessage")
      return Response.json({
        ok: true,
        channel: "D123",
        ts: "1503435956.000247",
        message: { text: parameters.text, type: "message" },
      });
    if (method === "chat.getPermalink")
      return Response.json({
        ok: true,
        channel: "D123",
        permalink: "https://example.slack.com/archives/D123/p1503435956000247",
      });
    return Response.json({ ok: false, error: "unknown_method" });
  };
  const client = HttpClient.make((request) => {
    const method = Str.split(new URL(request.url).pathname, "/").at(-1)!;
    const verb = ["conversations.list", "users.list", "chat.getPermalink"].includes(method)
      ? "GET"
      : "POST";
    if (request.method !== verb)
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ ok: false, error: "unknown_method" })),
      );
    const body =
      request.body._tag === "Uint8Array"
        ? (request.body.text ?? new TextDecoder().decode(request.body.body))
        : "";
    const parameters = Rec.map(
      Rec.fromEntries(request.method === "GET" ? request.urlParams : new URLSearchParams(body)),
      (value) => (Redacted.isRedacted(value) ? Redacted.value(value) : value),
    );
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        answer(
          method,
          parameters,
          pipe(request.headers.authorization ?? "", Str.startsWith("Bearer xoxb-"))
            ? "bot"
            : /^Bearer (xoxe\.)?xoxp-/.test(request.headers.authorization ?? "")
              ? "user"
              : null,
        ),
      ),
    );
  });
  return {
    client,
    calls,
    /** Which kind of token authorized each call, in step with `calls`. */
    authorized,
    /** Fields laid over each code exchange's answer, until replaced. */
    exchange: (fields: Partial<typeof SlackOAuthAnswer.Encoded>) => {
      exchanged = fields;
    },
    refuse: (reason: string | null, method?: string) => {
      refused = reason;
      refusedMethod = method;
    },
  };
};
