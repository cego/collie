// A Desktop and a host one board protocol apart still read each other's Slack.

import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { FrontDoorRpcs } from "../src/board-model";
import { ConnectionReading } from "../src/connection-model";
import { connect, frontDoor, socketOf } from "../src/host";
import { proves } from "./support/world";

const human = { state: "ok", account: "sam", detail: "Posts as sam in Example Co" } as const;

test("a protocol-4 host's Connections read with its human sign-in as slack, and its bot dropped", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const read = yield* Schema.decodeEffect(
        FrontDoorRpcs.requests.get("connections")!.successSchema,
      )([
        { id: "gitlab", reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" } },
        { id: "slack", reading: { state: "ok", account: "Collie", detail: "Collie bot" } },
        { id: "slack-user", reading: human },
      ]);
      expect(read).toEqual([
        { id: "gitlab", reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" } },
        { id: "slack", reading: human },
      ]);
    }),
  ));

test("a protocol-4 Desktop reads the host's Connections with the human signed in as slack-user", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const connections = FrontDoorRpcs.requests.get("connections")!.successSchema;
      const sent = yield* Schema.encodeEffect(connections)([
        { id: "gitlab", reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" } },
        { id: "slack", reading: human },
      ]);
      const protocol4 = Schema.Array(
        Schema.Struct({
          id: Schema.Literals(["gitlab", "github", "linear", "helle", "slack", "slack-user"]),
          reading: ConnectionReading,
        }),
      );
      expect(yield* Schema.decodeUnknownEffect(protocol4)(sent)).toEqual([
        { id: "gitlab", reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" } },
        { id: "slack-user", reading: human },
      ]);
      expect(yield* Schema.decodeEffect(connections)(sent)).toEqual([
        { id: "gitlab", reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" } },
        { id: "slack", reading: human },
      ]);
    }),
  ));

test("a protocol-4 Desktop asking the host for the bot's Slack choices is told to sign in", () =>
  proves(
    "collie-slack-protocol-",
    (world) =>
      Effect.gen(function* () {
        yield* connect(world.state);
        const door = yield* frontDoor(socketOf(world.state));
        const refused = yield* door.slackChoices().pipe(Effect.flip);
        expect(refused).toMatchObject({
          reason: "Collie no longer posts with a Slack bot token: sign in to Slack",
        });
      }),
    [],
  ));
