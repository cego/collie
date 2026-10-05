// Desktop's built app, started for a test against scripted hosts: Local's behind a local
// bridge, and each herdr machine's behind a scripted `ssh`, then found over CEF's
// debugging protocol. One app at a time: they share the port.

import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import type { TaskView } from "../../../src/board-model";
import { ScriptedMachine } from "./scripted-machine";

export const CDP = Bun.env.COLLIE_DESKTOP_CDP ?? "9333";
const APP = `${import.meta.dir}/../../build/dev-linux-x64/collie-desktop-dev/bin/launcher`;
export const HOST = `${import.meta.dir}/scripted-host.ts`;

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const asMachine = Schema.encodeSync(Schema.fromJsonString(ScriptedMachine));
const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** What a scripted host serves from now on, replaced whole so it never reads half a file. */
export const serve = (
  file: string,
  installation: string,
  tasks: ReadonlyArray<TaskView>,
  herds: ScriptedMachine["herds"] = [{ id: "default" }],
  build: Pick<ScriptedMachine, "build" | "development" | "protocol"> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${file}.new`, asMachine({ installation, herds, tasks, ...build }));
    yield* fs.rename(`${file}.new`, file);
  });

export const LOCAL = "local.json";

/**
 * herdr's list; a master that logs when it opens and closes, and which `-O check` finds
 * once it is open; and a passenger that runs its remote command as a Machine's login
 * shell would, with `collie` on PATH where the Machine has a board. While `down-<target>`
 * exists the target cannot be reached and its master drops, taking its passengers with it;
 * while `sso-<target>` exists a master waits on an SSO login.
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
refused() { echo "ssh: connect to host \${target#*@} port 22: Connection refused" >&2; exit 255; }
if [ "$1" = -M ]; then
  echo "open $target $PPID" >> '${flock}/ssh.log'
  if [ "$target" = mk@down ] || [ -e '${flock}'/"down-$target" ]; then refused; fi
  if [ -e '${flock}'/"sso-$target" ]; then
    echo "SSH access guarded by SSO. Log in at https://sso.example/device" >&2
    while [ -e '${flock}'/"sso-$target" ]; do sleep 0.1; done
  fi
  trap 'echo "closed $target" >> "${flock}/ssh.log"; rm -f "$control"; exit 0' TERM
  touch "$control"
  while [ ! -e '${flock}'/"down-$target" ]; do sleep 0.1; done
  rm -f "$control"
  refused
fi
if [ "\${args[2]}" = -O ]; then [ -e "$control" ]; exit; fi
[ -e "$control" ] || { echo "no master for $target" >&2; exit 255; }
[[ " $* " == *" ControlMaster=no "* ]] || { echo "a channel could log in by itself" >&2; exit 255; }
target="\${args[-2]}"
FAKE_TARGET="$target" SHELL='${flock}/remote/shell' /bin/sh -c "\${args[-1]}" <&0 &
passenger=$!
while kill -0 $passenger 2>/dev/null; do
  [ -e "$control" ] || { kill $passenger; echo "Shared connection to \${target#*@} closed." >&2; exit 255; }
  sleep 0.1
done
wait $passenger
`,
  // A login shell here would reset PATH from the system's profile.
  "remote/shell": `#!/bin/sh
[ "$1" = -lc ] && shift
PATH='${flock}/remote':"$PATH" exec /bin/sh -c "$@"
`,
  "remote/collie": `#!/bin/sh
[ -e '${flock}/'"$FAKE_TARGET.json" ] || { echo "sh: 1: exec: collie: not found" >&2; exit 127; }
exec '${process.execPath}' '${HOST}' '${flock}/'"$FAKE_TARGET.json" "$@"
`,
});

/** Retried until it holds, as a human would wait for the board to settle. */
export const settled = <A>(what: string, probe: () => Promise<A | undefined>, times = 100) =>
  Effect.tryPromise(probe).pipe(
    Effect.flatMap((found) =>
      found === undefined ? Effect.fail(`not yet: ${what}`) : Effect.succeed(found),
    ),
    Effect.retry({ times, schedule: Schedule.spaced("200 millis") }),
  );

export const reads = (locator: Locator, text: string) => {
  let seen: string | undefined;
  return settled(`"${text}"`, () =>
    locator.textContent({ timeout: 1000 }).then((now) => {
      seen = now?.trim();
      return seen === text ? true : undefined;
    }),
  ).pipe(Effect.mapError((error) => `${error}, reads "${seen}"`));
};

/** A saved herdr machine, as the scripted `herdr machine list --json` prints it. */
export interface Saved {
  readonly label: string;
  readonly target: string;
  readonly session: string;
  readonly enabled: boolean;
}

export interface App {
  readonly browser: Browser;
  readonly page: Page;
  /** Where the scripted hosts read their boards and log what they were asked. */
  readonly flock: string;
  /** The app's home, which a second launch can start on again. */
  readonly scratch: string;
  readonly process: ReturnType<typeof Bun.spawn>;
}

/**
 * Starts the app with herdr listing `machines`, once every board it reads is written: in a
 * home of its own, or in `home`, so it finds what an app there saved.
 */
export const launch = (
  machines: ReadonlyArray<Saved>,
  boards: (flock: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>,
  home?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratch = home ?? (yield* fs.makeTempDirectory({ prefix: "collie-desktop-" }));
    const flock = `${scratch}/flock`;
    yield* fs.remove(flock, { recursive: true, force: true });
    yield* fs.makeDirectory(`${flock}/remote`, { recursive: true });
    for (const [name, script] of Object.entries(scripts(flock))) {
      yield* fs.writeFileString(`${flock}/${name}`, script);
      yield* fs.chmod(`${flock}/${name}`, 0o755);
    }
    const saved = machines.map((machine, at) => ({
      id: `profile-${at}`,
      selected: false,
      ...machine,
    }));
    yield* fs.writeFileString(`${flock}/machines.json`, asJson(saved));
    yield* boards(flock);
    // Another app on the port would be the one driven, against a board this test never wrote.
    const stale = yield* Effect.tryPromise(() =>
      chromium.connectOverCDP(`http://127.0.0.1:${CDP}`),
    ).pipe(Effect.option);
    if (stale._tag === "Some") return yield* Effect.die(`port ${CDP} is already CEF's`);
    // In a session of its own, so the whole app goes with it; under Xvfb without a display.
    const display = Bun.env.DISPLAY === undefined ? ["xvfb-run", "-a"] : [];
    const process_ = Bun.spawn(["setsid", ...display, APP], {
      env: {
        ...Bun.env,
        // CEF keeps one profile per user, so a test's app must not find the operator's.
        HOME: scratch,
        XDG_DATA_HOME: `${scratch}/data`,
        PATH: `${flock}:${Bun.env.PATH}`,
        COLLIE_DESKTOP_COLLIE: asCommand([process.execPath, HOST, `${flock}/${LOCAL}`]),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    let seen: ReadonlyArray<string> = [];
    // Connected afresh each try: a connection made before the window opened may never see it.
    const found = yield* settled(
      "Desktop's window",
      () =>
        chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).then((browser) => {
          const pages = browser.contexts().flatMap((context) => context.pages());
          seen = pages.map((one) => one.url());
          const page = pages.find((one) => one.url().startsWith("views://"));
          return page === undefined ? browser.close().then(() => undefined) : { browser, page };
        }),
      250,
    ).pipe(
      Effect.mapError((error) => `${error}; pages: ${seen.join(", ")}`),
      // A start that never showed its window must not keep the port from the next one.
      Effect.tapError(() => quit({ process: process_ })),
    );
    return { ...found, flock, scratch, process: process_ } satisfies App;
  });

/** Ends the app and everything it started. */
export const quit = (app: Pick<App, "process"> | undefined) =>
  Effect.gen(function* () {
    if (app === undefined) return;
    try {
      process.kill(-app.process.pid, "SIGTERM");
    } catch {
      // Already gone: a test may have quit it itself.
    }
    yield* Effect.promise(() => app.process.exited);
  });
