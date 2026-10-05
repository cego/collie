// The built app, driven by Playwright over CEF's debugging protocol, against scripted
// hosts: Local's behind a local bridge, and each herdr machine's behind a scripted `ssh`.
// `bun run test` here builds the app with that protocol open.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { hostname } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, Schedule, Schema } from "effect";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import type { TaskView } from "../../src/board-model";
import { task } from "../../test/support/task";
import { ScriptedMachine } from "./support/scripted-machine";

const CDP = Bun.env.COLLIE_DESKTOP_CDP ?? "9333";
const APP = `${import.meta.dir}/../build/dev-linux-x64/collie-desktop-dev/bin/launcher`;
const HOST = `${import.meta.dir}/support/scripted-host.ts`;

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const asMachine = Schema.encodeSync(Schema.fromJsonString(ScriptedMachine));
const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

let app: ReturnType<typeof Bun.spawn> | undefined;

interface Harness {
  readonly browser: Browser;
  readonly page: Page;
  readonly flock: string;
  readonly now: number;
}
let harness: Harness;

/** What a scripted host serves from now on, replaced whole so it never reads half a file. */
const serve = (
  file: string,
  installation: string,
  tasks: ReadonlyArray<TaskView>,
  herds: ScriptedMachine["herds"] = [{ id: "default" }],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${file}.new`, asMachine({ installation, herds, tasks }));
    yield* fs.rename(`${file}.new`, file);
  });

const LOCAL = "local.json";

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
].map((machine, at) => ({ id: `profile-${at}`, selected: false, ...machine }));

/**
 * herdr's list; a master that logs when it opens and closes, and which `-O check` finds
 * once it is open; and a passenger that runs its remote command as a Machine's login
 * shell would, with `collie` on PATH.
 */
const scripts = (flock: string) => ({
  herdr: `#!/bin/sh
[ "$*" = "machine list --json" ] || exit 2
cat '${flock}/machines.json'
`,
  ssh: `#!/bin/bash
args=("$@")
target="\${args[-1]}"
for ((i = 0; i < \${#args[@]}; i++)); do [ "\${args[i]}" = -S ] && control="\${args[i+1]}"; done
if [ "$1" = -M ]; then
  echo "open $target $PPID" >> '${flock}/ssh.log'
  if [ "$target" = mk@down ]; then echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255; fi
  trap 'echo "closed $target" >> "${flock}/ssh.log"; rm -f "$control"; exit 0' TERM
  touch "$control"
  while :; do sleep 0.1; done
fi
if [ "\${args[2]}" = -O ]; then [ -e "$control" ]; exit; fi
[ -e "$control" ] || { echo "no master for $target" >&2; exit 255; }
[[ " $* " == *" ControlMaster=no "* ]] || { echo "a channel could log in by itself" >&2; exit 255; }
target="\${args[-2]}"
FAKE_TARGET="$target" SHELL='${flock}/remote/shell' exec /bin/sh -c "\${args[-1]}"
`,
  // A login shell here would reset PATH from the system's profile.
  "remote/shell": `#!/bin/sh
[ "$1" = -lc ] && shift
PATH='${flock}/remote':"$PATH" exec /bin/sh -c "$@"
`,
  "remote/collie": `#!/bin/sh
exec '${process.execPath}' '${HOST}' '${flock}/'"$FAKE_TARGET.json" "$@"
`,
});

/** Retried until it holds, as a human would wait for the board to settle. */
const settled = <A>(what: string, probe: () => Promise<A | undefined>, times = 100) =>
  Effect.tryPromise(probe).pipe(
    Effect.flatMap((found) =>
      found === undefined ? Effect.fail(`not yet: ${what}`) : Effect.succeed(found),
    ),
    Effect.retry({ times, schedule: Schedule.spaced("200 millis") }),
  );

const reads = (locator: Locator, text: string) => {
  let seen: string | undefined;
  return settled(`"${text}"`, () =>
    locator.textContent({ timeout: 1000 }).then((now) => {
      seen = now?.trim();
      return seen === text ? true : undefined;
    }),
  ).pipe(Effect.mapError((error) => `${error}, reads "${seen}"`));
};

const card = (section: string, id: string) =>
  harness.page.getByTestId(section).getByTestId(`card-${id}`);

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

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const scratch = yield* fs.makeTempDirectory({ prefix: "collie-desktop-" });
        const flock = `${scratch}/flock`;
        yield* fs.makeDirectory(`${flock}/remote`, { recursive: true });
        for (const [name, script] of Object.entries(scripts(flock))) {
          yield* fs.writeFileString(`${flock}/${name}`, script);
          yield* fs.chmod(`${flock}/${name}`, 0o755);
        }
        yield* fs.writeFileString(`${flock}/machines.json`, asJson(MACHINES));
        const now = yield* Clock.currentTimeMillis;
        const local = Object.values(fixtures(now));
        const { vm, box1, box2 } = remoteFixtures(now);
        yield* serve(`${flock}/${LOCAL}`, "pc", local);
        yield* serve(`${flock}/mk@pc.json`, "pc", local);
        yield* serve(`${flock}/mk@vm-mk.json`, "vm", [vm], VM_HERDS);
        yield* serve(`${flock}/mk@vm-alias.json`, "vm", [vm], VM_HERDS);
        yield* serve(`${flock}/mk@box1.json`, "box1", [box1]);
        yield* serve(`${flock}/mk@box2.json`, "box2", [box2]);
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
            PATH: `${flock}:${Bun.env.PATH}`,
            COLLIE_DESKTOP_COLLIE: asCommand([process.execPath, HOST, `${flock}/${LOCAL}`]),
          },
          stdout: "ignore",
          stderr: "ignore",
        });
        const browser = yield* settled(
          "CEF's debugging port",
          () => chromium.connectOverCDP(`http://127.0.0.1:${CDP}`),
          250,
        );
        const page = yield* settled(
          "Desktop's window",
          () =>
            Promise.resolve(
              browser
                .contexts()
                .flatMap((context) => context.pages())
                .find((one) => one.url().startsWith("views://")),
            ),
          250,
        );
        harness = { browser, page, flock, now };
      }),
    ),
  120_000,
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

const sshLog = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const log = yield* fs.readFileString(`${harness.flock}/ssh.log`);
    return log.trim().split("\n");
  });

test(
  "every Machine's cards are on one board, in sections counted across the Flock",
  () =>
    run(
      Effect.gen(function* () {
        const { working } = fixtures(harness.now);
        yield* reads(
          harness.page.getByTestId("header"),
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
        const { page } = harness;
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
          harness.page.getByTestId("lost-down").locator("[data-slot=description]"),
          "ssh: connect to host down port 22: Connection refused",
        );
        const lost = harness.page.locator("[data-testid^=lost-]");
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
        expect(opened.toSorted()).toEqual(
          MACHINES.filter((one) => one.enabled)
            .map((one) => `open ${one.target}`)
            .toSorted(),
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
        const { asking, working, waiting, finished } = fixtures(harness.now);
        const { page } = harness;
        yield* Effect.promise(() =>
          page.evaluate(() => Object.assign(window, { unrefreshed: true })),
        );
        yield* serve(`${harness.flock}/${LOCAL}`, "pc", [
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
