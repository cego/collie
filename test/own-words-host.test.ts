// A host gives the human's own words only to Desktop's own door, after the human's click
// there; every other door, a chat's tools among them, is refused without a word of them.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, FileSystem, Result, Schema, flow } from "effect";
import { expect, test } from "bun:test";
import { connect } from "../src/host";
import { stopHost } from "./support/host";
import type { Declaration } from "../src/board-model";
import { nowIso } from "../src/time";
import { proves } from "./support/world";

const encode = flow(
  Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const TYPED = "Keep pull requests small, and never force push to main.";

const session = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${home}/.claude/projects/-home-u-shop`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      `${dir}/0b7c-human.jsonl`,
      `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        type: "user",
        isSidechain: false,
        cwd: "/home/u/shop",
        sessionId: "0b7c-human",
        message: { role: "user", content: TYPED },
        timestamp: yield* nowIso,
      })}\n`,
    );
  });

/** Every file under `dir`, read whole, for a word of the fixture. */
const everything = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(dir, { recursive: true });
    const texts = yield* Effect.forEach(names, (name) =>
      fs.readFileString(`${dir}/${name}`).pipe(Effect.orElseSucceed(() => "")),
    );
    return Arr.join(texts, "\n");
  });

const declared: ReadonlyArray<Declaration> = [
  { frontDoor: "chat", conversation: "flock@mk-pc", said: "read my sessions" },
  { frontDoor: "agent", from: { agent: "build-1" } },
  { frontDoor: "cli" },
  { frontDoor: "cli-tty" },
  { frontDoor: "board" },
  { frontDoor: "driver" },
  { frontDoor: "evaluator" },
];

test(
  "the human's own words are read only on Desktop's door; any other is refused with none of them",
  () =>
    proves(
      "collie-own-words-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* session(world.home);
          yield* fs.makeDirectory(`${world.state}/agents`, { recursive: true });
          yield* fs.writeFileString(
            `${world.state}/agents/test.json`,
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
              {
                role: "implementer",
                agent: "build-1",
                paneId: "p-1",
                workspaceId: null,
                runId: "run-1",
                workflow: "implement",
                at: "2026-11-04T09:00:00.000Z",
              },
            ]),
          );

          // Started here, the host reads this world's home and not this process's.
          const desktop = yield* connect(world.state, { hostEnv: { HOME: world.home } });
          yield* desktop.declare({ frontDoor: "desktop" });
          const read = yield* desktop.ownWords();
          expect(Arr.map(read.messages, ({ text }) => text)).toEqual([TYPED]);

          const undeclared = yield* connect(world.state);
          const refusals = [yield* undeclared.ownWords().pipe(Effect.flip)];
          for (const door of declared) {
            const client = yield* connect(world.state);
            yield* client.declare(door);
            const refused = yield* client.ownWords().pipe(Effect.flip);
            expect([door.frontDoor, refused._tag]).toEqual([door.frontDoor, "HostRefused"]);
            refusals.push(refused);
          }
          for (const refused of refusals) {
            expect(refused).toMatchObject({ reason: expect.stringContaining("Desktop") });
            expect(encode(refused)).not.toContain("pull requests");
          }
          expect(yield* everything(world.state)).not.toContain("pull requests");

          const chat = yield* connect(world.state);
          yield* chat.declare({
            frontDoor: "chat",
            conversation: "flock@mk-pc",
            said: "how much?",
          });
          const inventory = yield* chat.ownInventory();
          expect(
            Option.getOrUndefined(
              Arr.findFirst(inventory.stores, ({ source }) => source === "claude-code"),
            ),
          ).toMatchObject({
            found: "read",
            sessions: 1,
          });
          expect(encode(inventory)).not.toContain("pull requests");
          yield* stopHost(world.state);
        }),
      [],
    ),
  120_000,
);
