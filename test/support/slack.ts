// Slack's documented Web API envelopes; requests are recorded without their authorization header.
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
export const fakeSlack = () => {
  const calls: Array<{ method: string; parameters: Record<string, string> }> = [];
  let refused: string | null = null;
  let refusedMethod: string | undefined;
  const answer = (method: string, parameters: Record<string, string>, authorized: boolean) => {
    calls.push({ method, parameters });
    if (!authorized) return Response.json({ ok: false, error: "invalid_auth" });
    if (refused !== null && (refusedMethod === undefined || refusedMethod === method))
      return Response.json({ ok: false, error: refused });
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
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(request.headers.authorization), (present) =>
              pipe(present, Str.startsWith("Bearer xoxb-")),
            ),
          ) ?? false,
        ),
      ),
    );
  });
  return {
    client,
    calls,
    refuse: (reason: string | null, method?: string) => {
      refused = reason;
      refusedMethod = method;
    },
  };
};
