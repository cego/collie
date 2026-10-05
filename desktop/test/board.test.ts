// The built app, driven by Playwright over CEF's debugging protocol, against a scripted
// host behind a local bridge. `bun run test` here builds the app with that protocol open.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, Schedule, Schema } from "effect";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { TaskView } from "../../src/board-model";
import { task } from "../../test/support/task";

const CDP = Bun.env.COLLIE_DESKTOP_CDP ?? "9333";
const APP = `${import.meta.dir}/../build/dev-linux-x64/collie-desktop-dev/bin/launcher`;
const HOST = `${import.meta.dir}/support/scripted-host.ts`;

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const asBoard = Schema.encodeSync(Schema.fromJsonString(Schema.Array(TaskView)));
const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

let app: ReturnType<typeof Bun.spawn> | undefined;

interface Harness {
  readonly browser: Browser;
  readonly page: Page;
  readonly board: string;
  readonly now: number;
}
let harness: Harness;

/** What the scripted host serves from now on, replaced whole so it never reads half a file. */
const serve = (board: string, tasks: ReadonlyArray<TaskView>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${board}.new`, asBoard(tasks));
    yield* fs.rename(`${board}.new`, board);
  });

/** Retried until it holds, as a human would wait for the board to settle. */
const settled = <A>(what: string, probe: () => Promise<A | undefined>) =>
  Effect.tryPromise(probe).pipe(
    Effect.flatMap((found) =>
      found === undefined ? Effect.fail(`not yet: ${what}`) : Effect.succeed(found),
    ),
    Effect.retry({ times: 150, schedule: Schedule.spaced("200 millis") }),
  );

const reads = (locator: Locator, text: string) =>
  settled(`"${text}"`, () =>
    locator.textContent().then((seen) => (seen?.trim() === text ? true : undefined)),
  );

const card = (section: string, id: string) =>
  harness.page.getByTestId(section).getByTestId(`card-${id}`);

const fixtures = (now: number) => ({
  asking: task({ id: "t-ask", name: "Pick a branch", state: "blocked", at: now - 1 }),
  working: task({ id: "t-work", name: "Fix the seeder", state: "active", at: now - 2 }),
  waiting: task({ id: "t-wait", name: "Ended unlanded", state: "failed", at: now - 3 }),
  finished: task({ id: "t-done", name: "Shipped", state: "done", at: now - 4 }),
});

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const scratch = yield* fs.makeTempDirectory({ prefix: "collie-desktop-" });
        const board = `${scratch}/board.json`;
        const now = yield* Clock.currentTimeMillis;
        yield* serve(board, Object.values(fixtures(now)));
        // Another app on the port would be the one driven, against a board this test never wrote.
        const stale = yield* Effect.tryPromise(() =>
          chromium.connectOverCDP(`http://127.0.0.1:${CDP}`),
        ).pipe(Effect.option);
        if (stale._tag === "Some") return yield* Effect.die(`port ${CDP} is already CEF's`);
        // In a session of its own, so the whole app goes with it; under Xvfb without a display.
        const display = Bun.env.DISPLAY === undefined ? ["xvfb-run", "-a"] : [];
        app = Bun.spawn(["setsid", ...display, APP], {
          env: {
            ...Bun.env,
            // CEF keeps one profile per user, so a test's app must not find the operator's.
            HOME: scratch,
            COLLIE_DESKTOP_COLLIE: asCommand([process.execPath, HOST, board]),
          },
          stdout: "ignore",
          stderr: "ignore",
        });
        const browser = yield* settled("CEF's debugging port", () =>
          chromium.connectOverCDP(`http://127.0.0.1:${CDP}`),
        );
        const page = yield* settled("Desktop's window", () =>
          Promise.resolve(
            browser
              .contexts()
              .flatMap((context) => context.pages())
              .find((one) => one.url().startsWith("views://")),
          ),
        );
        harness = { browser, page, board, now };
      }),
    ),
  60_000,
);

afterAll(() =>
  run(
    Effect.gen(function* () {
      if (app === undefined) return;
      process.kill(-app.pid, "SIGTERM");
      yield* Effect.promise(() => app?.exited ?? Promise.resolve(0));
    }),
  ),
);

test(
  "Desktop shows Local's cards in their sections, under the header sentence",
  () =>
    run(
      Effect.gen(function* () {
        const { working } = fixtures(harness.now);
        yield* reads(
          harness.page.getByTestId("header"),
          "One task is waiting on you. 1 waiting on you. 1 working.",
        );
        yield* reads(card("needs-you", "t-ask").getByTestId("state"), "Needs you");
        yield* reads(card("working", "t-work").getByTestId("sentence"), working.sentence);
        yield* reads(card("waiting", "t-wait").getByTestId("name"), "Ended unlanded");
        yield* reads(card("finished", "t-done").getByTestId("name"), "Shipped");
      }),
    ),
  30_000,
);

test(
  "a change on the host appears on its card without a refresh",
  () =>
    run(
      Effect.gen(function* () {
        const { asking, working, waiting, finished } = fixtures(harness.now);
        const { page } = harness;
        yield* Effect.promise(() =>
          page.evaluate(() => Object.assign(window, { unrefreshed: true })),
        );
        yield* serve(harness.board, [
          asking,
          { ...working, state: "blocked", sentence: "Asks whether to reseed staging." },
          waiting,
          finished,
        ]);
        yield* reads(
          card("needs-you", "t-work").getByTestId("sentence"),
          "Asks whether to reseed staging.",
        );
        yield* reads(
          page.getByTestId("header"),
          "2 tasks are waiting on you. 1 waiting on you. 0 working.",
        );
        expect(yield* Effect.promise(() => page.evaluate(() => "unrefreshed" in window))).toBe(
          true,
        );
      }),
    ),
  30_000,
);
