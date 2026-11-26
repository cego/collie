import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";

export interface CodexRelay {
  readonly url: string;
  readonly stop: () => void;
}

const TOKEN_HEADER = "x-collie-relay";
const answerHeaders = [
  "content-type",
  "mcp-session-id",
  "last-event-id",
  "cache-control",
  "www-authenticate",
];
const bodiless = (method: string) => method === "GET" || method === "HEAD";
const folded = (name: string) => pipe(name, Str.toLowerCase);

export const codexRelay: (
  target: string,
  headers: Readonly<Record<string, string>>,
  token: string,
) => CodexRelay = (target, headers, token) => {
  const origin = new URL(target).origin;
  const forward = (request: Request) => {
    if (request.headers.get(TOKEN_HEADER) !== token) {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    }
    const claimed = request.headers.get("origin");
    if (claimed !== null && claimed !== origin) {
      return Promise.resolve(new Response("Forbidden", { status: 403 }));
    }
    if (folded(request.headers.get("host") ?? "") !== folded(`${server.hostname}:${server.port}`)) {
      return Promise.resolve(new Response("Forbidden", { status: 403 }));
    }
    const held = new Headers(request.headers);
    held.delete("host");
    held.delete("content-length");
    held.delete(TOKEN_HEADER);
    for (const [name, value] of Rec.toEntries(headers)) {
      held.set(name, value);
    }
    return (bodiless(request.method) ? Promise.resolve(undefined) : request.arrayBuffer())
      .then((body) => Bun.fetch(target, { method: request.method, headers: held, body }))
      .then((asked) => {
        const passing = new Headers();
        for (const name of answerHeaders) {
          const value = asked.headers.get(name);
          if (value !== null) {
            passing.set(name, value);
          }
        }
        return new Response(asked.status === 204 ? null : asked.body, {
          status: asked.status,
          headers: passing,
        });
      })
      .catch(() => new Response("Bad gateway", { status: 502 }));
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: forward });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => void server.stop(true),
  };
};
