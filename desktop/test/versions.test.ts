// Desktop keeps the Flock on its own build, in the built app: an older release is moved to
// Desktop's version, a development checkout is only labelled, and a host whose board is
// newer than Desktop can read asks for a newer Desktop.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { PROTOCOL } from "../../src/board-model";
import { task } from "../../test/support/task";
import manifest from "../../herdr-plugin.toml";
import { chromium } from "playwright-core";
import { type App, CDP, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";

const MACHINES = [
  { label: "old", target: "mk@old", session: "default", enabled: true },
  { label: "dev", target: "mk@dev", session: "default", enabled: true },
  { label: "future", target: "mk@future", session: "default", enabled: true },
  { label: "next", target: "mk@next", session: "default", enabled: true },
];
const VERSION: string = manifest.version;
const fromJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ op: Schema.String, payload: Schema.Unknown })),
);
/** What the Flock chat's own channel asks of every Machine, none of it about its build. */
const CHAT = new Set(["declare", "news"]);

let app: App | undefined;

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const one = (id: string) => [task({ id, name: id, state: "active", at: now })];
        app = yield* launch(MACHINES, (flock) =>
          Effect.gen(function* () {
            yield* serve(`${flock}/${LOCAL}`, "pc", []);
            const herds = [{ id: "default" }];
            yield* serve(`${flock}/mk@old.json`, "old", one("t-old"), herds, { build: "0.1.0" });
            yield* serve(`${flock}/mk@dev.json`, "dev", one("t-dev"), herds, {
              build: "0.1.0",
              development: "0.1.0+abc1234",
            });
            yield* serve(`${flock}/mk@future.json`, "future", one("t-future"), herds, {
              build: "99.0.0",
              protocol: PROTOCOL + 2,
            });
            yield* serve(`${flock}/mk@next.json`, "next", one("t-next"), herds, {
              build: "99.0.0",
              protocol: PROTOCOL + 1,
            });
          }),
        );
      }),
    ),
  120_000,
);

afterAll(() => run(quit(app)));

const asked = (target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const log = yield* fs
      .readFileString(`${app!.flock}/${target}.json.ops.jsonl`)
      .pipe(Effect.orElseSucceed(() => ""));
    return log.trim() === ""
      ? []
      : log
          .trim()
          .split("\n")
          .map((line) => fromJson(line))
          .filter(({ op }) => !CHAT.has(op));
  });

test(
  "an older released Machine is upgraded to Desktop's exact version on connect, with a notice",
  () =>
    run(
      Effect.gen(function* () {
        yield* settled("the upgrade notice", () =>
          app!.page
            .getByText(`old upgraded 0.1.0 → ${VERSION}`)
            .count()
            .then((n) => (n > 0 ? true : undefined)),
        );
        yield* reads(app!.page.getByTestId("card-t-old").getByTestId("name"), "t-old");
        expect(yield* asked("mk@old")).toEqual([{ op: "upgrade", payload: { to: VERSION } }]);
      }),
    ),
  30_000,
);

test(
  "a development checkout is labelled with its build and never upgraded",
  () =>
    run(
      Effect.gen(function* () {
        yield* reads(
          app!.page.getByTestId("development-dev").locator("[data-slot=description]"),
          "development build 0.1.0+abc1234",
        );
        yield* reads(app!.page.getByTestId("card-t-dev").getByTestId("name"), "t-dev");
        expect(yield* asked("mk@dev")).toEqual([]);
      }),
    ),
  30_000,
);

test(
  "a Machine newer than the protocol window asks for a newer Desktop, and one inside it is read as it is",
  () =>
    run(
      Effect.gen(function* () {
        yield* reads(
          app!.page.getByTestId("lost-future").locator("[data-slot=title]"),
          "Update Desktop to see future",
        );
        expect(yield* Effect.promise(() => app!.page.getByTestId("card-t-future").count())).toBe(0);
        yield* reads(app!.page.getByTestId("card-t-next").getByTestId("name"), "t-next");
        expect(yield* asked("mk@next")).toEqual([]);
        expect(yield* asked("mk@future")).toEqual([]);
      }),
    ),
  30_000,
);

test(
  "a chat popped out of the board doctors no Machine again",
  () =>
    run(
      Effect.gen(function* () {
        const doctored = (target: string) =>
          Bun.file(`${app!.flock}/${target}`)
            .text()
            .catch(() => "")
            .then((text) => text.split("\n").filter(Boolean).length);
        const boards = [LOCAL, "mk@old.json", "mk@dev.json", "mk@next.json"];
        yield* settled("the board's doctor", () =>
          Promise.all(boards.map((board) => doctored(`${board}.doctored`))).then((counts) =>
            counts.every((n) => n > 0) ? true : undefined,
          ),
        );
        yield* Effect.promise(() => app!.page.getByTestId("chat-pop-out").click());
        // Connected afresh each try: a connection made before the window opened may never see it.
        const { browser, page: chat } = yield* settled("the chat's own window", () =>
          chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).then((browser) => {
            const page = browser
              .contexts()
              .flatMap((context) => context.pages())
              .find((one) => one.url().endsWith("#chat"));
            return page === undefined ? browser.close().then(() => undefined) : { browser, page };
          }),
        );
        yield* settled("the popped chat", () =>
          chat
            .getByTestId("flock-chat")
            .count()
            .then((n) => (n > 0 ? true : undefined)),
        );
        // As long as a second board takes to reach every Machine and doctor it.
        yield* Effect.sleep("3 seconds");
        for (const board of boards)
          expect([board, yield* Effect.promise(() => doctored(`${board}.doctored`))]).toEqual([
            board,
            1,
          ]);
        yield* Effect.promise(() => chat.getByTestId("chat-pop-in").click());
        yield* Effect.promise(() => browser.close());
      }),
    ),
  60_000,
);
