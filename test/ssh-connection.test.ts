// ADR-draft-a-blocked-link-rides-the-machines-ssh-connection, against the fake ssh.

import { expect, test } from "bun:test";
import { createConnection, createServer, type Server } from "node:net";
import { Clock, Deferred, type Duration, Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  closeConnections,
  controlPath,
  controlPathOf,
  openConnection,
  sshConnection,
} from "../src/ssh-connection";
import { remoteCollie, riderArgv } from "../src/ssh-argv";
import { withLock } from "../src/lock";
import { runEffect } from "./support/effect";
import { freePort, portOf, silentMaster, writeFakeSsh, socketDir } from "./support/fake-ssh";
import { root } from "./support/host";

const vm = { label: "vm-mk", target: "mk@vm-mk" };

/** A fake ssh in a directory of its own, and a state directory beside it. */
const rig = Effect.gen(function* () {
  const dir = yield* socketDir("ssh-");
  const ssh = `${dir}/ssh`;
  const fake = yield* writeFakeSsh(ssh, dir);
  return { dir, state: `${dir}/state`, ssh, fake };
});

const opens = (state: string, ssh: string, bound: Duration.Input = "2 minutes") =>
  Effect.gen(function* () {
    const stderr: Array<string> = [];
    const opened = yield* openConnection(state, vm, {
      ssh,
      said: (text) => Effect.sync(() => void stderr.push(text)),
      bound,
    });
    return { ...opened, stderr: stderr.join("") };
  });

/** Runs an argv to its end, answering its exit code. */
const run = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [command, ...args] = argv;
    return Number(
      yield* spawner.exitCode(
        ChildProcess.make(command!, args, { stdin: "ignore", extendEnv: true }),
      ),
    );
  }).pipe(Effect.orDie);

test("a Machine's control path is its own, private, and refused where a socket could not bind it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, state, fake } = yield* rig;
      const path = yield* controlPath(state, vm);
      expect(path.startsWith(`${state}/ssh/`)).toBe(true);
      expect(path.slice(`${state}/ssh/`.length)).toMatch(/^[0-9a-f]{16}$/);
      expect((yield* fs.stat(`${state}/ssh`)).mode & 0o777).toBe(0o700);
      expect(controlPathOf(state, { ...vm, label: "other" })).not.toBe(path);
      expect(controlPathOf(state, { ...vm, target: "mk@elsewhere" })).not.toBe(path);
      expect(controlPathOf(`${state}x`, vm).length).toBe(path.length + 1);

      const deep = `${dir}/${"d".repeat(80)}`;
      const refused = yield* controlPath(deep, vm).pipe(Effect.flip);
      expect(refused.reason).toContain(controlPathOf(deep, vm));
      expect(yield* fs.exists(`${deep}/ssh`)).toBe(false);
      const unopened = yield* opens(deep, `${dir}/ssh`).pipe(Effect.flip);
      expect(unopened._tag).toBe("HostRefused");
      expect(yield* fake.calls).toEqual([]);
    }),
  ));

test("the opener starts one master, says what it said, and answers the path once it answers", () =>
  runEffect(
    Effect.gen(function* () {
      const { state, ssh, fake } = yield* rig;
      const opened = yield* opens(state, ssh);
      expect(opened).toMatchObject({
        path: controlPathOf(state, vm),
        opened: true,
      });
      expect(opened.stderr).toContain("Authenticated to mk@vm-mk");
      expect((yield* fake.calls).filter((line) => line.startsWith("master"))).toEqual([
        "master mk@vm-mk",
      ]);

      const again = yield* opens(state, ssh);
      expect(again).toMatchObject({ path: opened.path, opened: false });
      expect((yield* fake.calls).filter((line) => line.startsWith("master"))).toHaveLength(1);
    }),
  ));

test(
  "openers in separate processes that come together start one master between them",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { dir, state, ssh, fake } = yield* rig;
        const opener = `${dir}/opener.ts`;
        // Outside the repository, a bare import would be auto-installed at another version.
        yield* fs.writeFileString(
          opener,
          `import * as BunServices from "${Bun.resolveSync("@effect/platform-bun/BunServices", root)}";
import { Effect } from "${Bun.resolveSync("effect", root)}";
import { openConnection } from "${root}src/ssh-connection.ts";
const [state, ssh, out] = process.argv.slice(2);
const { opened } = await Effect.runPromise(
  openConnection(state!, { label: "${vm.label}", target: "${vm.target}" }, {
    ssh,
    said: () => Effect.void,
  }).pipe(Effect.provide(BunServices.layer)),
);
await Bun.write(out!, String(opened));
`,
        );
        // Its answer goes to a file: the master it starts keeps a stdout pipe open.
        const codes = yield* Effect.all(
          [0, 1].map((one) =>
            Effect.promise(
              () =>
                Bun.spawn(
                  [process.execPath, "--no-install", opener, state, ssh, `${dir}/opened-${one}`],
                  {
                    stdio: ["ignore", "ignore", "inherit"],
                    env: { ...process.env, TMPDIR: dir },
                  },
                ).exited,
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(codes).toEqual([0, 0]);
        const opened = yield* Effect.forEach([0, 1], (one) =>
          fs.readFileString(`${dir}/opened-${one}`),
        );
        expect(opened.toSorted((a, b) => a.localeCompare(b))).toEqual(["false", "true"]);
        expect((yield* fake.calls).filter((line) => line.startsWith("master"))).toEqual([
          "master mk@vm-mk",
        ]);
      }),
    ),
  30_000,
);

test("a master that never answers within the opener's bound fails with what ssh said", () =>
  runEffect(
    Effect.gen(function* () {
      const { state, ssh, fake } = yield* rig;
      yield* fake.hangs(true);
      const failed = yield* opens(state, ssh, "1 second").pipe(Effect.flip);
      expect(failed._tag).toBe("MachineUnreachable");
      if (failed._tag === "MachineUnreachable") {
        expect(failed.machine).toBe("vm-mk");
        expect(failed.seen).toContain("Waiting for SSO login");
      }
    }),
  ));

test("waiting on another opener counts against the opener's bound", () =>
  runEffect(
    Effect.gen(function* () {
      const { state, ssh, fake } = yield* rig;
      yield* fake.hangs(true);
      const path = yield* controlPath(state, vm);
      const held = yield* Deferred.make<void>();
      yield* withLock(
        `${path}.lock`,
        Effect.die("the lock was taken"),
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.sleep("400 millis"))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const started = yield* Clock.currentTimeMillis;
      const failed = yield* opens(state, ssh, "600 millis").pipe(Effect.flip);
      expect(failed._tag).toBe("MachineUnreachable");
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(900);
    }),
  ));

test("a lock held past the opener's bound fails the open at the bound, however slow each claim", () =>
  runEffect(
    Effect.gen(function* () {
      const { state, ssh } = yield* rig;
      const path = yield* controlPath(state, vm);
      const held = yield* Deferred.make<void>();
      yield* withLock(
        `${path}.lock`,
        Effect.die("the lock was taken"),
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const started = yield* Clock.currentTimeMillis;
      const failed = yield* opens(state, ssh, "300 millis").pipe(
        Effect.updateService(FileSystem.FileSystem, (fs) => ({
          ...fs,
          writeFileString: (file, data, options) =>
            Effect.sleep("20 millis").pipe(Effect.andThen(fs.writeFileString(file, data, options))),
        })),
        Effect.flip,
      );
      expect(failed._tag).toBe("MachineUnreachable");
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(450);
    }),
  ));

test("an opener whose master never answers its check fails within its bound", () =>
  runEffect(
    Effect.gen(function* () {
      const { state, ssh } = yield* rig;
      yield* silentMaster(yield* controlPath(state, vm));
      const started = yield* Clock.currentTimeMillis;
      const failed = yield* opens(state, ssh, "300 millis").pipe(Effect.flip);
      expect(failed._tag).toBe("MachineUnreachable");
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);
    }),
  ));

test("the host's handle gives up on a master that never answers", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { state, ssh } = yield* rig;
      const path = yield* controlPath(state, vm);
      yield* silentMaster(path);
      const handle = yield* sshConnection(state, vm, ssh, "200 millis");
      const started = yield* Clock.currentTimeMillis;
      expect(yield* handle.check).toBe(false);
      const refused = yield* Effect.scoped(handle.forward(1, 2)).pipe(Effect.flip);
      expect(refused._tag).toBe("HostRefused");
      yield* handle.exit;
      expect(yield* fs.exists(path)).toBe(false);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(2_000);
    }),
  ));

test("the host's handle only asks an open master, and cancels its forward when its scope closes", () =>
  runEffect(
    Effect.gen(function* () {
      const { state, ssh, fake } = yield* rig;
      const handle = yield* sshConnection(state, vm, ssh);
      expect(yield* handle.check).toBe(false);
      const refused = yield* Effect.scoped(handle.forward(1, 2)).pipe(Effect.flip);
      expect(refused._tag).toBe("HostRefused");
      expect((yield* fake.calls).every((line) => line.startsWith("mux "))).toBe(true);

      yield* opens(state, ssh);
      expect(yield* handle.check).toBe(true);
      const far = yield* Effect.acquireRelease(
        Effect.callback<Server>((resume) => {
          const server = createServer((conn) => conn.end("from afar"));
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) => Effect.sync(() => server.close()),
      );
      const farPort = portOf(far);
      const local = yield* freePort;
      const heard = yield* Effect.scoped(
        handle.forward(local, farPort).pipe(
          Effect.andThen(
            Effect.callback<string>((resume) => {
              let said = "";
              const conn = createConnection({ host: "127.0.0.1", port: local });
              conn.on("data", (chunk) => (said += chunk.toString("utf8")));
              conn.once("close", () => resume(Effect.succeed(said)));
            }),
          ),
        ),
      );
      expect(heard).toBe("from afar");
      const calls = yield* fake.calls;
      const spec = `127.0.0.1:${local}:127.0.0.1:${farPort}`;
      expect(calls).toContain(`mux forward ${spec} mk@vm-mk`);
      expect(calls.at(-1)).toBe(`mux cancel ${spec} mk@vm-mk`);
      expect(calls.filter((line) => line.startsWith("master"))).toHaveLength(1);
      expect(calls.some((line) => line.startsWith("login") || line.startsWith("ride"))).toBe(false);
    }),
  ));

test("`exit` ends an open master and its path, and only removes a path left behind by one that ended", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { state, ssh, fake } = yield* rig;
      const { path } = yield* opens(state, ssh);
      const handle = yield* sshConnection(state, vm, ssh);
      yield* handle.exit;
      expect((yield* fake.calls).at(-1)).toBe("mux exit vm-mk");
      expect(yield* fs.exists(path)).toBe(false);

      yield* fs.writeFileString(path, "");
      yield* handle.exit;
      expect(yield* fs.exists(path)).toBe(false);
      expect((yield* fake.calls).some((line) => line.startsWith("login"))).toBe(false);
    }),
  ));

test("the host closes every connection under its state but those of the machines it keeps", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { state, ssh, fake } = yield* rig;
      const other = { label: "other", target: "mk@other" };
      const kept = (yield* opens(state, ssh)).path;
      const gone = yield* openConnection(state, other, {
        ssh,
        said: () => Effect.void,
      });
      yield* fs.writeFileString(`${state}/ssh/${"0".repeat(16)}.binding`, "");
      const closed = yield* closeConnections(state, [vm], ssh);
      expect(closed).toEqual([gone.path]);
      expect(yield* fs.exists(gone.path)).toBe(false);
      expect(yield* fs.exists(kept)).toBe(true);
      expect(yield* fs.exists(`${state}/ssh/${"0".repeat(16)}.binding`)).toBe(true);
      expect(
        (yield* fake.calls).filter(
          (line) => !line.startsWith("master") && !line.startsWith("mux check"),
        ),
      ).toEqual(["mux exit collie"]);
    }),
  ));

test("a session built from the rider argv rides an open master and never logs in where it has gone", () =>
  runEffect(
    Effect.gen(function* () {
      const { state, ssh, fake } = yield* rig;
      const path = controlPathOf(state, vm);
      expect(yield* run(riderArgv(path, vm.target, "true", ssh))).toBe(255);
      expect((yield* fake.calls).some((line) => line.startsWith("login"))).toBe(false);

      yield* opens(state, ssh);
      expect(yield* run(riderArgv(path, vm.target, "true", ssh))).toBe(0);
      expect((yield* fake.calls).at(-1)).toBe("ride mk@vm-mk true");
      expect(riderArgv(path, vm.target, "true")).toEqual([
        "ssh",
        "-S",
        path,
        "-o",
        "ControlMaster=no",
        "-o",
        "ProxyCommand=false",
        "-T",
        vm.target,
        "true",
      ]);
    }),
  ));

test("a command for a Machine's login shell is quoted word by word", () => {
  expect(remoteCollie(["machine", "it's"])).toBe(
    `exec "\${SHELL:-/bin/sh}" -lc 'exec collie "$@"' collie machine 'it'\\''s'`,
  );
});
