import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, Stream } from "effect";
import {
  bridgeCommand,
  linkRoute,
  openDoors,
  remoteRoute,
  removeFromHerdr,
  type ShellRoute,
} from "../desktop/src/bun/machine";
import { giveHelle, giveToken } from "../desktop/src/bun/credentials";
import { readAudit } from "../src/audit";
import { peersOf } from "../src/peers";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { releaseBinary, twoMachines, type Side } from "./support/peers";
import { freePort } from "./support/fake-ssh";
import { collieCommand } from "./support/world";
import { runDir } from "../src/engine";
import { readLaunches } from "../src/launches";
import { BUILD, connect, ownerOf } from "../src/host";
import { stopHost, until } from "./support/host";

const SECOND = {
  id: "second",
  label: "second",
  target: "mk@second",
  session: "default",
  enabled: true,
};

/** `side`'s own collie, logging each command it is given and the control path it was told. */
const loggedCollie = (side: Side) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const command = `${side.world.home}/local-collie`;
    const log = `${command}.log`;
    const real = [
      "env",
      ...Arr.map(Rec.toEntries(side.env), ([key, value]) => `${key}=${value}`),
      ...(yield* collieCommand),
    ];
    yield* fs.writeFileString(
      command,
      `#!/bin/sh\necho "control=\${COLLIE_SSH_CONTROL-} $*" >> '${log}'\nexec ${Arr.join(
        Arr.map(real, (word) => `'${word}'`),
        " ",
      )} "$@"\n`,
      { mode: 0o755 },
    );
    const asked = fs.readFileString(log).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
    );
    return { command: [command], asked };
  });

test(
  "a link upgrade replaces the far host even while Local is a development checkout",
  () =>
    runEffect(
      twoMachines(
        "collie-desktop-upgrade-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* exec(["git", "init", "-q", "-b", "development"], { cwd: first.world.install });
            const current = yield* collieCommand;
            const newer = current.length === 1 ? current[0]! : `${second.world.home}/newer-collie`;
            if (current.length !== 1) yield* releaseBinary(newer, BUILD);
            const older = `${second.world.home}/older-collie`;
            yield* releaseBinary(older, "0.0.1");
            const bin = Str.split(second.env.PATH!, ":")[0]!;
            yield* fs.writeFileString(
              `${bin}/collie`,
              `#!/bin/sh\nif [ "$1 $2 $3" = "--json upgrade --to" ]; then cp '${newer}' '${older}.new' && chmod +x '${older}.new' && mv '${older}.new' '${older}'; exit $?; fi\nexec env COLLIE_HOST='["${older}"]' '${older}' "$@"\n`,
              { mode: 0o755 },
            );
            yield* first.lists([second]);
            yield* first.cli(["--machine", "second", "board"]);
            const [peer] = yield* peersOf(first.world.state);
            const fallback: ShellRoute = {
              machine: { profile: "second", name: "second", target: "mk@second" },
              open: () => Effect.die("SSH should not open"),
              collie: () => Effect.die("SSH should not run"),
              sh: () => Effect.die("SSH should not run"),
              forward: () => Effect.void,
            };
            const route = linkRoute(
              yield* collieCommand,
              peer!,
              fallback,
              "desktop-test",
              first.env,
            );
            const initial = yield* route.open(() => Effect.void);
            expect(
              (yield* (yield* connect(first.world.state)).identity()).development,
            ).toBeDefined();
            const before = yield* ownerOf(second.world.state);
            expect((yield* initial.board.pipe(Stream.take(1), Stream.runCollect))[0]).toMatchObject(
              { build: "0.0.1" },
            );
            expect((yield* route.collie(["--json", "upgrade", "--to", BUILD])).code).toBe(0);
            yield* until(
              () => ownerOf(second.world.state),
              (owner) => owner !== null && owner.pid !== before?.pid,
            );
            yield* until(
              () => first.cli(["--machine", "second", "board"]),
              (answer) => answer.envelope.ok,
            );
            const after = yield* route.open(() => Effect.void);
            expect((yield* after.board.pipe(Stream.take(1), Stream.runCollect))[0]).toMatchObject({
              build: BUILD,
            });
          }),
        [],
      ),
    ),
  180_000,
);

test(
  "removing a Machine in Desktop forgets the live pairing without another action",
  () =>
    runEffect(
      twoMachines(
        "collie-desktop-remove-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            yield* first.cli(["--machine", "second", "board"]);
            const fs = yield* FileSystem.FileSystem;
            const remove = `${first.world.home}/herdr-remove`;
            yield* fs.writeFileString(
              remove,
              `#!/bin/sh\nprintf '[]' > '${first.herdrLog}.machines.json'\n`,
              { mode: 0o755 },
            );
            yield* removeFromHerdr(remove, "second", [
              "env",
              ...Arr.map(Rec.toEntries(first.env), ([key, value]) => `${key}=${value}`),
              ...(yield* collieCommand),
            ]);
            expect(yield* peersOf(first.world.state)).toEqual([]);
            yield* until(
              () => peersOf(second.world.state),
              (peers) => peers.length === 0,
            );
          }),
        [],
      ),
    ),
  180_000,
);

test(
  "Desktop pairs on the shared SSH connection its route opened after an older Collie gains invite, once",
  () =>
    runEffect(
      twoMachines(
        "collie-desktop-pair-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* first.lists([second]);
            yield* first.cli(["machine", "list"]);
            const bin = Str.split(second.env.PATH!, ":")[0]!;
            const ready = `${second.world.home}/upgraded`;
            yield* fs.rename(`${bin}/collie`, `${bin}/collie-real`);
            yield* fs.writeFileString(
              `${bin}/collie`,
              `#!/bin/sh\nif [ "$1 $2 $3" = "--json machine invite" ] && [ ! -e '${ready}' ]; then echo 'invite is not installed' >&2; exit 1; fi\nexec '${bin}/collie-real' "$@"\n`,
              { mode: 0o755 },
            );
            const local = yield* loggedCollie(first);
            const ssh = yield* remoteRoute(
              `${Str.split(first.env.PATH!, ":")[0]}/ssh`,
              local.command,
              SECOND,
              "desktop-test",
              false,
              true,
            );
            const route = linkRoute(
              yield* collieCommand,
              { name: "second" },
              ssh,
              "desktop-test",
              first.env,
              false,
            );
            expect((yield* route.open(() => Effect.void)).machine.route).toBe("ssh");
            expect(yield* route.pair!).toContain("Could not pair second");
            expect(yield* peersOf(first.world.state)).toEqual([]);
            yield* fs.writeFileString(ready, "yes");
            expect(yield* route.pair!).toBeNull();
            expect(yield* route.pair!).toBeNull();
            expect((yield* route.open(() => Effect.void)).machine.route).toBe("link");
            expect(yield* peersOf(first.world.state)).toHaveLength(1);
            const calls = yield* fs.readFileString(first.sshLog);
            expect(
              Arr.filter(Str.split(calls, "\n"), (line) => pipe_(line, Str.startsWith("master"))),
            ).toHaveLength(1);
            expect(
              Arr.filter(
                Str.split(calls, "\n"),
                (line) =>
                  pipe_(line, Str.startsWith("ride")) && pipe_(line, Str.includes("invite")),
              ),
            ).toHaveLength(2);
            expect(
              Arr.filter(Str.split(calls, "\n"), (line) => pipe_(line, Str.startsWith("login"))),
            ).toEqual([]);
            const locally = yield* local.asked;
            expect(
              Arr.filter(locally, (line) => pipe_(line, Str.endsWith("machine connect second"))),
            ).toHaveLength(1);
            expect(
              Arr.filter(locally, (line) => pipe_(line, Str.endsWith("--machine second board"))),
            ).toHaveLength(2);
            expect(Arr.every(locally, (line) => pipe_(line, Str.startsWith("control= ")))).toBe(
              true,
            );
          }),
        [],
      ),
    ),
  180_000,
);

test(
  "Desktop reads a paired board and runs commands and credentials over its link, opening no SSH connection until one is needed",
  () =>
    runEffect(
      twoMachines(
        "collie-desktop-peer-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const outputs = `${second.world.home}/outputs.json`;
            yield* fs.writeFileString(
              outputs,
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
                { verdict: "done" },
              ]).pipe(Effect.orDie),
            );
            const started = yield* second.cli(
              ["run", "start", "attended", "--input", "work=Desktop link"],
              { FAKE_HERDR_OUTPUTS: outputs },
            );
            const { runId } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ runId: Schema.String }),
            )(started.envelope.data).pipe(Effect.orDie);
            const host = yield* connect(second.world.state);
            yield* until(
              () => host.run({ runId }),
              (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
            );
            yield* first.lists([second]);
            yield* first.cli(["--machine", "second", "board"]);
            const [peer] = yield* peersOf(first.world.state);
            const local = yield* loggedCollie(first);
            const ssh = yield* remoteRoute(
              `${Str.split(first.env.PATH!, ":")[0]}/ssh`,
              local.command,
              SECOND,
              "desktop-test",
              true,
            );
            const fallback: ShellRoute = {
              ...ssh,
              open: () => Effect.fail({ state: "unreachable", reason: "not opened" }),
              collie: () => Effect.die("the link should carry this"),
            };
            const route = linkRoute(
              yield* collieCommand,
              peer!,
              fallback,
              "desktop-test",
              first.env,
            );
            const doors = yield* route.open(() => Effect.void);
            const board = yield* doors.board.pipe(Stream.take(1), Stream.runCollect);
            expect(board[0]?._tag).toBe("Snapshot");
            const delivered = yield* doors.chat.act({
              request: "desktop-chat-delivery",
              actions: [
                {
                  kind: "deliver",
                  run: runId,
                  agent: (yield* readLaunches(second.world.state, runId))[0]!.agent,
                  text: "from Flock chat",
                  mode: "boundary",
                },
              ],
            });
            expect(delivered[0]).toMatchObject({ state: "applied" });
            expect(
              Option.getOrUndefined(
                Arr.findFirst(yield* readAudit(runDir(second.world.state, runId)), (line) =>
                  pipe_(line.request, Str.startsWith("desktop-chat-delivery")),
                ),
              )?.actor,
            ).toMatchObject({ origin: "chat", from: { client: "desktop-test" } });
            expect((yield* route.collie(["--version"])).out).toContain("collie");
            const bin = Str.split(second.env.PATH!, ":")[0]!;
            yield* fs.rename(`${bin}/collie`, `${bin}/collie-real`);
            yield* fs.writeFileString(
              `${bin}/collie`,
              `#!/bin/sh\nif [ "$1 $2" = "--json upgrade" ]; then echo '{"ok":true}'; exit 0; fi\nexec '${bin}/collie-real' "$@"\n`,
              { mode: 0o755 },
            );
            expect((yield* route.collie(["--json", "upgrade", "--to", "0.47.0"])).code).toBe(0);
            yield* route.collie(["--json", "doctor"]);
            yield* fs.writeFileString(
              `${bin}/glab`,
              `#!/bin/sh\ncat > '${second.world.home}/token'\n`,
              { mode: 0o755 },
            );
            expect(yield* giveToken([route], "gitlab.example.com", "token-test")).toEqual([
              { name: "second", failed: null },
            ]);
            expect(yield* fs.readFileString(`${second.world.home}/token`)).toBe("token-test\n");
            expect(yield* giveHelle([route], "https://helle.example.com", "helle-test")).toEqual([
              { name: "second", failed: null },
            ]);
            expect(yield* fs.readFileString(`${second.world.home}/.config/helle/env`)).toContain(
              "HELLE_API_TOKEN=helle-test",
            );
            expect(yield* local.asked).toEqual([]);
            const [incoming] = yield* peersOf(second.world.state);
            expect((yield* readAudit(`${second.world.state}/shell`))[0]?.actor).toMatchObject({
              origin: "desktop",
              from: { machine: { installation: incoming!.installation }, client: "desktop-test" },
            });
            yield* Effect.scoped(route.forward(yield* freePort));
            expect(yield* local.asked).toEqual(["control= --json machine connect second"]);
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "a link that is away opens its SSH route, which starts the far host",
  () =>
    runEffect(
      twoMachines(
        "collie-desktop-fallback-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            yield* first.cli(["--machine", "second", "board"]);
            const [peer] = yield* peersOf(first.world.state);
            yield* stopHost(second.world.state);
            const command = yield* collieCommand;
            let opened = 0;
            const fallback: ShellRoute = {
              machine: { profile: "second", name: "second", target: "mk@second", route: "ssh" },
              open: () =>
                Effect.sync(() => opened++).pipe(
                  Effect.andThen(
                    openDoors(
                      { profile: "second", name: "second", route: "ssh" },
                      (as) => bridgeCommand(command, "desktop-test", as),
                      second.env,
                    ),
                  ),
                ),
              collie: () => Effect.die("not asked"),
              sh: () => Effect.die("not asked"),
              forward: () => Effect.void,
            };
            const route = linkRoute(command, peer!, fallback, "desktop-test", first.env);
            const doors = yield* route.open(() => Effect.void);
            expect(opened).toBe(1);
            expect(doors.machine.route).toBe("ssh");
            expect((yield* doors.board.pipe(Stream.take(1), Stream.runCollect))[0]?._tag).toBe(
              "Snapshot",
            );
          }),
        [],
      ),
    ),
  180_000,
);
