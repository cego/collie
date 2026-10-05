// The built app, driven by Playwright over CEF's debugging protocol, against scripted
// hosts: Local's behind a local bridge, and each herdr machine's behind a scripted `ssh`.
// `bun run test` here builds the app with that protocol open.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { hostname } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem } from "effect";
import { task } from "../../test/support/task";
import { type App, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";

/**
 * The machines saved in herdr. Two reach vm-mk's state directory and one reaches this
 * computer's, so they show as one Machine each; two share a label; one is disabled; and
 * one cannot be reached at all.
 */
const MACHINES = [
  { label: "vm-mk", target: "mk@vm-mk", session: "default", enabled: true },
  { label: "vm-mk again", target: "mk@vm-alias", session: "work", enabled: true },
  { label: "this computer", target: "mk@pc", session: "default", enabled: true },
  { label: "box", target: "mk@box1", session: "default", enabled: true },
  { label: "box", target: "mk@box2", session: "default", enabled: true },
  { label: "off", target: "mk@off", session: "default", enabled: false },
  { label: "down", target: "mk@down", session: "default", enabled: true },
];

const card = (section: string, id: string) =>
  app!.page.getByTestId(section).getByTestId(`card-${id}`);

const fixtures = (now: number) => ({
  asking: task({ id: "t-ask", name: "Pick a branch", state: "blocked", at: now - 1 }),
  working: task({ id: "t-work", name: "Fix the seeder", state: "active", at: now - 2 }),
  waiting: task({ id: "t-wait", name: "Ended unlanded", state: "failed", at: now - 3 }),
  finished: task({ id: "t-done", name: "Shipped", state: "done", at: now - 4 }),
});

const VM_HERDS = [
  { id: "h1", name: "default" },
  { id: "h2", name: "work" },
];
const remoteFixtures = (now: number) => ({
  vm: task({ id: "t-vm", name: "Reseed staging", state: "active", herd: "h2", at: now - 5 }),
  box1: task({ id: "t-box1", name: "Box one", state: "done", at: now - 6 }),
  box2: task({ id: "t-box2", name: "Box two", state: "done", at: now - 7 }),
});

let app: App | undefined;
let now = 0;

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        now = yield* Clock.currentTimeMillis;
        app = yield* launch(MACHINES, (flock) =>
          Effect.gen(function* () {
            const local = Object.values(fixtures(now));
            const { vm, box1, box2 } = remoteFixtures(now);
            yield* serve(`${flock}/${LOCAL}`, "pc", local);
            yield* serve(`${flock}/mk@pc.json`, "pc", local);
            yield* serve(`${flock}/mk@vm-mk.json`, "vm", [vm], VM_HERDS);
            yield* serve(`${flock}/mk@vm-alias.json`, "vm", [vm], VM_HERDS);
            yield* serve(`${flock}/mk@box1.json`, "box1", [box1]);
            yield* serve(`${flock}/mk@box2.json`, "box2", [box2]);
          }),
        );
      }),
    ),
  120_000,
);

afterAll(() => run(quit(app)));

const sshLog = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const log = yield* fs.readFileString(`${app!.flock}/ssh.log`);
    return log.trim().split("\n");
  });

test(
  "every Machine's cards are on one board, in sections counted across the Flock",
  () =>
    run(
      Effect.gen(function* () {
        const { working } = fixtures(now);
        yield* reads(
          app!.page.getByTestId("header"),
          "One task is waiting on you. 1 waiting on you. 2 working.",
        );
        yield* reads(card("needs-you", "t-ask").getByTestId("state"), "Needs you");
        yield* reads(card("working", "t-work").getByTestId("sentence"), working.sentence);
        yield* reads(card("waiting", "t-wait").getByTestId("name"), "Ended unlanded");
        yield* reads(card("finished", "t-done").getByTestId("name"), "Shipped");
        yield* reads(card("working", "t-vm").getByTestId("name"), "Reseed staging");
      }),
    ),
  30_000,
);

test(
  "a Machine reached two ways is one, and a card says which Machine and Herd it is on",
  () =>
    run(
      Effect.gen(function* () {
        const { page } = app!;
        yield* reads(card("working", "t-work").getByTestId("where"), hostname());
        yield* reads(card("working", "t-vm").getByTestId("where"), "vm-mk · work");
        yield* reads(card("finished", "t-box1").getByTestId("where"), "box (mk@box1)");
        yield* reads(card("finished", "t-box2").getByTestId("where"), "box (mk@box2)");
        expect(yield* Effect.promise(() => page.getByTestId("card-t-vm").count())).toBe(1);
        expect(yield* Effect.promise(() => page.getByTestId("card-t-work").count())).toBe(1);
      }),
    ),
  30_000,
);

test(
  "a Machine that cannot be reached says so by name, beside the rest of the Flock",
  () =>
    run(
      Effect.gen(function* () {
        yield* reads(
          app!.page.getByTestId("lost-down").locator("[data-slot=description]"),
          "ssh: connect to host down port 22: Connection refused",
        );
        const lost = app!.page.locator("[data-testid^=lost-]");
        expect(yield* Effect.promise(() => lost.count())).toBe(1);
      }),
    ),
  30_000,
);

test(
  "every enabled herdr machine gets one master, and each stays open while Desktop runs",
  () =>
    run(
      Effect.gen(function* () {
        const opened = (yield* sshLog()).map((line) => line.split(" ").slice(0, 2).join(" "));
        // The one out of reach is tried again; every other is opened once and held.
        expect([...new Set(opened)].toSorted()).toEqual(
          MACHINES.filter((one) => one.enabled)
            .map((one) => `open ${one.target}`)
            .toSorted(),
        );
        expect(opened.filter((line) => line !== "open mk@down")).toHaveLength(
          MACHINES.filter((one) => one.enabled).length - 1,
        );
      }),
    ),
  30_000,
);

test(
  "a change on the host appears on its card without a refresh",
  () =>
    run(
      Effect.gen(function* () {
        const { asking, working, waiting, finished } = fixtures(now);
        const { page } = app!;
        yield* Effect.promise(() =>
          page.evaluate(() => Object.assign(window, { unrefreshed: true })),
        );
        yield* serve(`${app!.flock}/${LOCAL}`, "pc", [
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
          "2 tasks are waiting on you. 1 waiting on you. 1 working.",
        );
        expect(yield* Effect.promise(() => page.evaluate(() => "unrefreshed" in window))).toBe(
          true,
        );
      }),
    ),
  30_000,
);

test(
  "quitting Desktop closes every master it opened",
  () =>
    run(
      Effect.gen(function* () {
        const [first] = yield* sshLog();
        const desktop = Number(first?.split(" ")[2]);
        process.kill(desktop, "SIGTERM");
        const live = MACHINES.filter((one) => one.enabled && one.target !== "mk@down");
        yield* settled("every master closed", () =>
          Effect.runPromise(
            sshLog().pipe(
              Effect.provide(BunServices.layer),
              Effect.map((lines) =>
                live.every((one) => lines.includes(`closed ${one.target}`)) ? true : undefined,
              ),
            ),
          ),
        );
      }),
    ),
  30_000,
);
