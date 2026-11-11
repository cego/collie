// The human's Claude Code servers as Pi registers them, and what the Pi chat is told of them.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Option, Result, Schema } from "effect";
import type { UserMcpServer, UserMcpServers } from "./session";

const Strings = Schema.Record(Schema.String, Schema.String);
const PiOAuth = Schema.Struct({
  clientId: Schema.optionalKey(Schema.String),
  callbackPort: Schema.optionalKey(Schema.Finite),
  authServerMetadataUrl: Schema.optionalKey(Schema.String),
});
export const PiServer = Schema.Union([
  Schema.Struct({
    command: Schema.String,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Strings),
    exposure: Schema.Literal("deferred"),
  }),
  Schema.Struct({
    type: Schema.Literal("http"),
    url: Schema.String,
    headers: Schema.optionalKey(Strings),
    oauth: Schema.optionalKey(PiOAuth),
    exposure: Schema.Literal("deferred"),
  }),
]);
export type PiServer = typeof PiServer.Type;

export interface PiServers {
  readonly given: Readonly<Record<string, PiServer>>;
  readonly left: ReadonlyArray<{ readonly name: string; readonly why: string }>;
}

const PI_NAME = /^[A-Za-z0-9_-]+$/;
const decodeStdio = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literal("stdio")),
    command: Schema.String,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Strings),
  }),
);
const decodeHttp = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("http"),
    url: Schema.String,
    headers: Schema.optionalKey(Strings),
    oauth: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeOAuth = Schema.decodeUnknownOption(PiOAuth);

const asPi = (server: UserMcpServer): Result.Result<PiServer, string> => {
  if ("headersHelper" in server) return Result.fail("its headersHelper runs only in Claude Code");
  if (server.type === "sse") return Result.fail("Pi does not speak SSE");
  const stdio = Option.getOrUndefined(decodeStdio(server));
  if (stdio !== undefined) {
    const { type: _, ...pi } = stdio;
    return Result.succeed({ ...pi, exposure: "deferred" });
  }
  return Option.match(decodeHttp(server), {
    onNone: () => Result.fail("Pi cannot read its configuration"),
    onSome: ({ oauth, ...http }) => {
      const known = Option.getOrUndefined(decodeOAuth(oauth));
      return Result.succeed({
        ...http,
        ...(known !== undefined && { oauth: known }),
        exposure: "deferred",
      });
    },
  });
};

const NONE: PiServers = { given: {}, left: [] };
const piName = (name: string) => pipe(name, Str.replaceAll("-", "_"));

/** Each server Pi can run, and each it cannot with why; Pi reads `-` and `_` alike in a name. */
export const piServers = (servers: UserMcpServers): PiServers =>
  Arr.reduce(Rec.toEntries(servers), NONE, (so, [name, server]) => {
    const leave = (why: string): PiServers => ({ ...so, left: [...so.left, { name, why }] });
    if (name === "collie") return leave("the name of Collie's own server");
    if (!PI_NAME.test(name))
      return leave("Pi takes only letters, digits, _ and - in a server's name");
    const same = Arr.findFirst(Rec.keys(so.given), (taken) => piName(taken) === piName(name));
    if (Option.isSome(same)) return leave(`Pi reads it as the same server as ${same.value}`);
    return Result.match(asPi(server), {
      onFailure: leave,
      onSuccess: (pi) => ({ ...so, given: { ...so.given, [name]: pi } }),
    });
  });

export const piConnections = ({ given, left }: PiServers) => {
  const names = Rec.keys(given);
  return Arr.join(
    [
      `Of the MCP servers the human added to Claude Code, this chat has ${
        names.length === 0 ? "none" : Arr.join(names, ", ")
      }, beside any in Pi's own mcp.json. Find their tools with tool_search. When tool_search finds none of a server's tools, it is not connected, most often because Pi needs the human's own sign-in to it: tell them so, and that typing /mcp login <server> in this chat opens that sign-in in their browser, rather than start a Run to do what the tool would. What Pi reports about a server comes with the human's next message.`,
      ...(left.length === 0
        ? []
        : [
            `Left out: ${Arr.join(
              Arr.map(left, ({ name, why }) => `${name} (${why})`),
              ", ",
            )}.`,
          ]),
      "claude.ai's connectors, such as Slack, reach only this chat's Claude harness: say so when one is asked for rather than claim a tool you do not have.",
    ],
    " ",
  );
};
