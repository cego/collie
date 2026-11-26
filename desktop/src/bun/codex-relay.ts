import * as Rec from "effect/Record";

export interface CodexRelay {
  readonly url: string;
  readonly stop: () => void;
}

const answerHeaders = ["content-type", "mcp-session-id", "last-event-id", "cache-control"];
const bodiless = (method: string) => method === "GET" || method === "HEAD";

export const codexRelay: (
  target: string,
  headers: Readonly<Record<string, string>>,
) => CodexRelay = (target, headers) => {
  const forward = (request: Request) => {
    const held = new Headers(request.headers);
    held.delete("host");
    held.delete("content-length");
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
