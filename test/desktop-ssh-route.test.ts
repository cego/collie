// ADR-draft-a-blocked-link-rides-the-machines-ssh-connection: a fake local `collie` stands
// in for `machine connect`.

import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Scope, Exit } from "effect";
import { BRIDGE_READY } from "../src/board-model";
import { riderArgv } from "../src/ssh-argv";
import { bridgeCommand, linkRoute, remoteRoute, type ShellRoute } from "../desktop/src/bun/machine";
import { runEffect } from "./support/effect";
import { freePort, silentMaster, writeFakeSsh, socketDir } from "./support/fake-ssh";

const vm = { id: "vm", label: "vm-mk", target: "mk@vm-mk", session: "default", enabled: true };

const rig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* socketDir("route-");
  const ssh = `${dir}/ssh`;
  yield* fs.makeDirectory(`${dir}/far`);
  const fake = yield* writeFakeSsh(ssh, dir, {
    PATH: `${dir}/far:/usr/bin:/bin`,
    SHELL: "/bin/sh",
  });
  const path = `${dir}/ctl`;
  const scripts = {
    // The far Machine's collie: a bridge that is ready at once, or the words it was given.
    "far/collie": `#!/bin/sh
if [ "$1" = bridge ]; then echo '${BRIDGE_READY}'; exec cat >/dev/null; fi
echo "far $*"
`,
    // This computer's collie: `machine connect` opens the shared connection, as Collie's does.
    collie: `#!/bin/sh
echo "control=\${COLLIE_SSH_CONTROL-} $*" >> '${dir}/collie.log'
if [ "$1 $2 $3" = "--json machine connect" ]; then
  [ -e '${dir}/refuses' ] && { echo '{"ok":false,"error":{"message":"refused"}}'; exit 1; }
  [ -e '${dir}/sso' ] && { echo 'Waiting for SSO login for mk@vm-mk' >&2; sleep 0.3; }
  '${ssh}' -M -N -S '${path}' -o ControlPersist=yes mk@vm-mk 2>/dev/null
  echo '{"ok":true,"data":{"machine":"vm-mk","path":"${path}","opened":true}}'
  exit 0
fi
exit 1
`,
  };
  for (const [name, script] of Rec.toEntries(scripts))
    yield* fs.writeFileString(`${dir}/${name}`, script, { mode: 0o755 });
  const collieLog = fs.readFileString(`${dir}/collie.log`).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
  );
  const connects = collieLog.pipe(
    Effect.map((lines) =>
      Arr.filter(lines, (line) => pipe_(line, Str.endsWith("machine connect vm-mk"))),
    ),
  );
  const sso = (on: boolean) =>
    (on ? fs.writeFileString(`${dir}/sso`, "") : fs.remove(`${dir}/sso`, { force: true })).pipe(
      Effect.orDie,
    );
  const refuses = fs.writeFileString(`${dir}/refuses`, "").pipe(Effect.orDie);
  return { dir, ssh, fake, path, collie: [`${dir}/collie`], collieLog, connects, sso, refuses };
});

const run = (argv: ReadonlyArray<string>) =>
  Effect.promise(() => {
    const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
    return Promise.all([new Response(child.stdout).text(), child.exited]);
  }).pipe(Effect.map(([out, code]) => ({ out, code })));

const kinds = (calls: ReadonlyArray<string>, kind: string) =>
  Arr.filter(calls, (line) => pipe_(line, Str.startsWith(kind)));

test("the SSH route opens its connection through collie machine connect and rides the path it answers", () =>
  runEffect(
    Effect.gen(function* () {
      const { ssh, fake, path, collie, connects } = yield* rig;
      const route = yield* remoteRoute(ssh, collie, vm, "mk-pc", true);
      expect(yield* connects).toEqual([]);

      const script = yield* route.sh("echo hi");
      expect(script).toEqual(
        riderArgv(path, "mk@vm-mk", `exec "\${SHELL:-/bin/sh}" -lc 'echo hi'`, ssh),
      );
      expect(yield* run(script)).toEqual({ out: "hi\n", code: 0 });
      expect((yield* route.collie(["--version"])).out).toBe("far --version\n");
      const port = yield* freePort;
      yield* Effect.scoped(route.forward(port));
      const doors = yield* Effect.scoped(route.open(() => Effect.void));
      expect(doors.machine.route).toBe("ssh");

      expect(yield* connects).toEqual(["control= --json machine connect vm-mk"]);
      const calls = yield* fake.calls;
      expect(kinds(calls, "master")).toHaveLength(1);
      expect(kinds(calls, "login")).toEqual([]);
      expect(kinds(calls, "mux forward")).toEqual([
        `mux forward ${port}:127.0.0.1:${port} mk@vm-mk`,
      ]);
      expect(kinds(calls, "mux cancel")).toHaveLength(1);
      expect(kinds(calls, "ride").length).toBeGreaterThanOrEqual(4);
    }),
  ));

test("a machine connect that names SSO shows the banner once, and the route opens when it answers", () =>
  runEffect(
    Effect.gen(function* () {
      const { ssh, collie, sso } = yield* rig;
      yield* sso(true);
      const route = yield* remoteRoute(ssh, collie, vm, "mk-pc", true);
      const told: Array<string> = [];
      const doors = yield* Effect.scoped(
        route.open((said) => Effect.sync(() => void told.push(said))),
      );
      expect(doors.machine.name).toBe("vm-mk");
      expect(told).toHaveLength(1);
      expect(told[0]).toContain("SSO");
    }),
  ));

test("an SSO login a route starts before it is opened still shows its banner when it is", () =>
  runEffect(
    Effect.gen(function* () {
      const { ssh, collie, sso } = yield* rig;
      yield* sso(true);
      const route = yield* remoteRoute(ssh, collie, vm, "mk-pc");
      yield* Effect.sleep("150 millis");
      const told: Array<string> = [];
      yield* Effect.scoped(route.open((said) => Effect.sync(() => void told.push(said))));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain("SSO");
    }),
  ));

test("a link whose bridge names SSO before it is ready shows the banner", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir } = yield* rig;
      yield* fs.writeFileString(
        `${dir}/bridging`,
        `#!/bin/sh\necho 'Waiting for SSO login for mk@vm-mk' >&2\nsleep 0.2\necho '${BRIDGE_READY}'\nexec cat >/dev/null\n`,
        { mode: 0o755 },
      );
      const fallback: ShellRoute = {
        machine: { profile: "vm", name: "vm-mk", target: "mk@vm-mk" },
        open: () => Effect.die("SSH should not open"),
        collie: () => Effect.die("SSH should not run"),
        sh: () => Effect.die("SSH should not run"),
        forward: () => Effect.void,
      };
      const route = linkRoute([`${dir}/bridging`], { name: "vm-mk" }, fallback, "mk-pc");
      const told: Array<string> = [];
      const doors = yield* Effect.scoped(
        route.open((said) => Effect.sync(() => void told.push(said))),
      );
      expect(doors.machine.route).toBe("link");
      expect(told.length).toBeGreaterThanOrEqual(1);
      expect(told[0]).toContain("SSO");
      expect(bridgeCommand([], "mk-pc")).toEqual([
        "bridge",
        "--as",
        "desktop",
        "--client",
        "mk-pc",
      ]);
    }),
  ));

test("a connection found gone is opened again, once for uses that come together", () =>
  runEffect(
    Effect.gen(function* () {
      const { ssh, fake, collie, connects } = yield* rig;
      const route = yield* remoteRoute(ssh, collie, vm, "mk-pc", true);
      yield* route.collie(["one"]);
      yield* fake.drop;
      const answers = yield* Effect.all(
        [route.collie(["two"]), route.collie(["three"]), route.sh("true")],
        { concurrency: "unbounded" },
      );
      expect(answers[0].out).toBe("far two\n");
      expect(answers[1].out).toBe("far three\n");
      expect(yield* connects).toHaveLength(2);
      expect(kinds(yield* fake.calls, "login")).toEqual([]);
    }),
  ));

test("a dropped master's control path is gone once the drop answers, so another can bind it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (let round = 0; round < 20; round++) {
        const { ssh, fake, path } = yield* rig;
        yield* run([ssh, "-M", "-N", "-S", path, "-o", "ControlPersist=yes", "mk@vm-mk"]);
        yield* fake.drop;
        expect(yield* fs.exists(path)).toBe(false);
      }
    }),
  ));

test("a connection whose master stops answering is not waited on: the next use connects again", () =>
  runEffect(
    Effect.gen(function* () {
      const { ssh, fake, path, collie, connects, refuses } = yield* rig;
      const route = yield* remoteRoute(ssh, collie, vm, "mk-pc", true, false, "200 millis");
      yield* route.collie(["one"]);
      yield* fake.drop;
      yield* silentMaster(path);
      yield* refuses;
      expect(yield* route.collie(["two"]).pipe(Effect.flip)).toContain("refused");
      expect(yield* connects).toHaveLength(2);
    }),
  ));

test("a channel whose connection ends after the check fails rather than log in, and the next use opens it", () =>
  runEffect(
    Effect.gen(function* () {
      const { ssh, fake, collie, connects } = yield* rig;
      const route = yield* remoteRoute(ssh, collie, vm, "mk-pc", true);
      yield* route.collie(["one"]);
      yield* fake.dropsBeforeRide(true);
      const failed = yield* route.collie(["two"]);
      expect(failed.code).not.toBe(0);
      expect(kinds(yield* fake.calls, "login")).toEqual([]);
      yield* fake.dropsBeforeRide(false);
      expect((yield* route.collie(["three"])).out).toBe("far three\n");
      expect(yield* connects).toHaveLength(2);
      expect(kinds(yield* fake.calls, "login")).toEqual([]);
    }),
  ));

test("closing a route's scope leaves the shared connection open", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { ssh, fake, path, collie } = yield* rig;
      const scope = yield* Scope.make();
      const route = yield* remoteRoute(ssh, collie, vm, "mk-pc").pipe(Scope.provide(scope));
      yield* route.collie(["one"]);
      yield* Scope.close(scope, Exit.void);
      expect(kinds(yield* fake.calls, "mux exit")).toEqual([]);
      expect(yield* fs.exists(path)).toBe(true);
    }),
  ));
