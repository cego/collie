// Desktop keeps the Flock on its own build, in the built app: an older release is moved to
// Desktop's version, a development checkout is only labelled, and a host whose board is
// newer than Desktop can read asks for a newer Desktop.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { PROTOCOL } from "../../src/board-model";
import { task } from "../../test/support/task";
import manifest from "../../herdr-plugin.toml";
import { type App, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";

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
