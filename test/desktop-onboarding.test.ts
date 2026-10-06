// Desktop onboards a Machine: herdr's questions while it saves one, a runner of Desktop's
// own version that is used only once its signature verifies, `collie onboard`'s steps as
// they come, and routes that come and go while Desktop runs.

import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { Clock, Deferred, Effect, FileSystem, Option, Schedule, type Scope, Stream } from "effect";
import type { BoardMessage, BoardSnapshot } from "../src/board-model";
import { signRelease } from "../src/signing";
import { flockStream, localRoute, type Route } from "../desktop/src/bun/machine";
import {
  addToHerdr,
  doctorOn,
  onboardThrough,
  platformOf,
  verifiedRunner,
} from "../desktop/src/bun/onboarding";
import {
  applyItem,
  EMPTY_FLOCK,
  type FlockItem,
  machineRows,
  type OnboardRun,
  type OnboardStep,
} from "../desktop/src/shared/flock";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

const scratch = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "collie-onboarding-" }),
);

/** A release server with `files` under `/<version>/`, which logs every path asked for. */
const releases = (files: Record<string, Uint8Array | string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const asked: string[] = [];
      const server = Bun.serve({
        port: 0,
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          asked.push(path);
          const body = files[path];
          return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
        },
      });
      return { base: `http://127.0.0.1:${server.port}`, asked, server };
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  );

test("Machines are told apart by what uname says they are", () => {
  expect(platformOf("Linux x86_64")).toBe("linux-x64");
  expect(platformOf("Linux aarch64\n")).toBe("linux-arm64");
  expect(platformOf("Darwin arm64")).toBe("darwin-arm64");
  expect(platformOf("SunOS sparc")).toBeNull();
});

test("a runner is used only once its signature verifies, from the download or from the copy kept of it", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const key = pair();
      const bytes = new TextEncoder().encode("#!/bin/sh\necho runner\n");
      const served = yield* releases({
        "/0.40.0/collie-linux-x64": bytes,
        "/0.40.0/collie-linux-x64.sig": signRelease(bytes, key.privateKey),
      });
      const runner = yield* verifiedRunner(served.base, "0.40.0", "linux-x64", dir, key.publicKey);
      expect(runner.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(new TextDecoder().decode(runner.bytes)).toBe("#!/bin/sh\necho runner\n");

      // The copy kept is checked again, so one changed since is refused rather than run.
      served.asked.length = 0;
      yield* verifiedRunner(served.base, "0.40.0", "linux-x64", dir, key.publicKey);
      expect(served.asked).toEqual([]);
      yield* fs.writeFileString(`${dir}/0.40.0/collie-linux-x64`, "#!/bin/sh\necho changed\n");
      const tampered = yield* verifiedRunner(
        served.base,
        "0.40.0",
        "linux-x64",
        dir,
        key.publicKey,
      ).pipe(Effect.flip);
      expect(tampered).toContain("does not match its signature");
    }),
  ));

test("an unsigned runner, or one signed by another key, is refused and never kept", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const key = pair();
      const bytes = new TextEncoder().encode("#!/bin/sh\n");
      const unsigned = yield* releases({ "/0.40.0/collie-linux-x64": bytes });
      expect(
        yield* verifiedRunner(unsigned.base, "0.40.0", "linux-x64", dir, key.publicKey).pipe(
          Effect.flip,
        ),
      ).toContain("unsigned");
      const forged = yield* releases({
        "/0.40.0/collie-linux-x64": bytes,
        "/0.40.0/collie-linux-x64.sig": signRelease(bytes, pair().privateKey),
      });
      expect(
        yield* verifiedRunner(forged.base, "0.40.0", "linux-x64", dir, key.publicKey).pipe(
          Effect.flip,
        ),
      ).toContain("does not match its signature");
      expect(yield* fs.exists(`${dir}/0.40.0/collie-linux-x64`)).toBe(false);
    }),
  ));

/** A `herdr` that asks what `machine add` asks, then logs its arguments and the answer. */
const fakeHerdr = (dir: string, exit = 0) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const herdr = `${dir}/herdr`;
    yield* fs.writeFileString(
      herdr,
      `#!/bin/sh
echo "Connecting to $7..."
printf 'Remote herdr is missing. Install it? [Y/n] '
read install
echo "This stops active remote pane processes."
printf 'The remote server is incompatible. Stop and replace the running server now? [y/N] '
read replace
echo "$* install=$install replace=$replace" > '${dir}/herdr.log'
exit ${exit}
`,
    );
    yield* fs.chmod(herdr, 0o755);
    return herdr;
  });

test("herdr's questions while it saves a Machine are asked of the human, each with herdr's own default", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const herdr = yield* fakeHerdr(dir);
      const asked: Array<[string, boolean]> = [];
      yield* addToHerdr(herdr, "mk@vm", "vm", "default", (text, yes) =>
        Effect.sync(() => {
          asked.push([text, yes]);
          // Yes to installing herdr; replacing a server is left at herdr's No.
          return yes;
        }),
      );
      expect(asked).toEqual([
        ["Connecting to mk@vm...\nRemote herdr is missing. Install it?", true],
        [
          "This stops active remote pane processes.\nThe remote server is incompatible. Stop and replace the running server now?",
          false,
        ],
      ]);
      expect((yield* fs.readFileString(`${dir}/herdr.log`)).trim()).toBe(
        "machine add --label vm --remote-session default mk@vm install=y replace=n",
      );
    }),
  ));

test("a long stretch of herdr's output with no question in it is read in no time", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const herdr = `${dir}/herdr`;
      yield* fs.writeFileString(
        herdr,
        `#!/bin/sh
for i in $(seq 40); do echo "Installing herdr, step $i of 40"; done
`,
      );
      yield* fs.chmod(herdr, 0o755);
      yield* addToHerdr(herdr, "mk@vm", "vm", "default", () => Effect.succeed(false));
    }),
  ));

test("herdr refusing to save a Machine is said in its own words", () =>
  run(
    Effect.gen(function* () {
      const dir = yield* scratch;
      const herdr = yield* fakeHerdr(dir, 1);
      const failed = yield* addToHerdr(herdr, "mk@vm", "vm", "default", () =>
        Effect.succeed(false),
      ).pipe(Effect.flip);
      expect(failed).toContain("replace the running server now?");
    }),
  ));

/** A runner that streams `collie --json onboard` as one whose system step needs root. */
const ONBOARD = `#!/bin/sh
[ "$*" = "--json onboard --to 0.40.0" ] || { echo "asked $*" >&2; exit 2; }
echo '{"event":"start","step":"system","title":"Checking for git, curl and openssl"}'
echo '{"event":"result","step":"system","status":"needs_root","detail":"git must be installed as root","command":"sudo apt-get install -y git"}'
echo '{"ok":false,"error":{"code":"operation_failed","message":"Not onboarded yet","details":{"ready":false,"steps":[]}}}'
exit 1
`;

test("onboarding puts the verified runner on the Machine and streams its steps, a root step with its command", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const home = `${dir}/home`;
      yield* fs.makeDirectory(home);
      const key = pair();
      const bytes = new TextEncoder().encode(ONBOARD);
      const uname = (yield* Effect.promise(() => Bun.$`uname -sm`.text())).trim();
      const platform = platformOf(uname)!;
      const served = yield* releases({
        [`/0.40.0/collie-${platform}`]: bytes,
        [`/0.40.0/collie-${platform}.sig`]: signRelease(bytes, key.privateKey),
      });
      const route = { ...localRoute([], "pc"), sh: localSh(home) };
      const runs: OnboardRun[] = [];
      const last = yield* onboardThrough(
        route,
        { version: "0.40.0", releases: served.base, runners: `${dir}/runners`, key: key.publicKey },
        (now) => Effect.sync(() => void runs.push(now)),
      );
      expect(last.ready).toBe(false);
      expect(last.steps).toEqual([
        {
          step: "runner",
          title: "Collie 0.40.0's runner, signed",
          status: "done",
          detail: `collie-${platform}, verified against Collie's release key`,
        },
        {
          step: "system",
          title: "Checking for git, curl and openssl",
          status: "needs_root",
          detail: "git must be installed as root",
          command: "sudo apt-get install -y git",
        },
      ]);
      // Every change was told as it came, the first while the runner was still on its way.
      expect(runs[0]!.steps).toEqual([
        { step: "runner", title: "Collie 0.40.0's runner, signed", status: "running" },
      ]);
      expect(yield* fs.readFile(`${home}/.cache/collie/runners/collie-0.40.0`)).toEqual(bytes);
    }),
  ));

test("a runner that does not verify is never put on the Machine, and onboarding says why", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const home = `${dir}/home`;
      yield* fs.makeDirectory(home);
      const uname = (yield* Effect.promise(() => Bun.$`uname -sm`.text())).trim();
      const served = yield* releases({
        [`/0.40.0/collie-${platformOf(uname)}`]: new TextEncoder().encode(ONBOARD),
      });
      const last = yield* onboardThrough(
        { ...localRoute([], "pc"), sh: localSh(home) },
        {
          version: "0.40.0",
          releases: served.base,
          runners: `${dir}/runners`,
          key: pair().publicKey,
        },
        () => Effect.void,
      );
      expect(last.ready).toBe(false);
      expect(last.steps.map(({ step, status }) => [step, status])).toEqual([["runner", "failed"]]);
      expect(last.steps[0]!.detail).toContain("unsigned");
      expect(yield* fs.exists(`${home}/.cache/collie/runners`)).toBe(false);
    }),
  ));

/** Local's shell, in a home of the test's own. */
const localSh = (home: string) => (script: string) =>
  Effect.succeed(["/usr/bin/env", `HOME=${home}`, "/bin/sh", "-c", script]);

const snapshot = (installation: string): BoardSnapshot => ({
  _tag: "Snapshot",
  installation,
  build: "0.31.0",
  protocol: 1,
  herds: [],
  tasks: [],
  seq: 0,
});
interface Fake {
  readonly board: () => Stream.Stream<BoardMessage, { readonly message: string }>;
}
const until = (what: () => boolean) =>
  Effect.suspend(() => (what() ? Effect.void : Effect.fail("not yet"))).pipe(
    Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 2000 }),
  );

test("a route added while Desktop runs shows its Machine, one removed stops, and a woken one tries again at once", () =>
  run(
    Effect.gen(function* () {
      const told: string[] = [];
      const closed: string[] = [];
      let installed = false;
      const route = (name: string): Route<Fake> => ({
        machine: { profile: `p-${name}`, name, target: `mk@${name}` },
        open: () =>
          installed || name !== "bare"
            ? Effect.acquireRelease(
                Effect.succeed<Fake>({
                  board: () => Stream.make(snapshot(name)).pipe(Stream.concat(Stream.never)),
                }),
                () => Effect.sync(() => closed.push(name)),
              )
            : Effect.fail({ state: "no-collie" as const, reason: "collie: not found" }),
        collie: () => Effect.die("not asked"),
      });
      const changes = yield* Deferred.make<void>();
      const removed = yield* Deferred.make<void>();
      const later = yield* Deferred.make<void>();
      yield* flockStream(
        [route("pc"), route("bare")],
        new Map(),
        "0.31.0",
        Stream.fromEffect(Deferred.await(changes)).pipe(
          Stream.flatMap(() =>
            Stream.make(
              { _tag: "Add", route: route("vm") } as const,
              { _tag: "Remove", profile: "p-pc", done: removed } as const,
            ),
          ),
          Stream.concat(
            Stream.fromEffect(Deferred.await(later)).pipe(
              Stream.map(() => ({ _tag: "Wake", profile: "p-bare" }) as const),
            ),
          ),
        ),
      ).pipe(
        Stream.runForEach((item: FlockItem) =>
          Effect.sync(() =>
            told.push(`${item.machine.name} ${"_tag" in item ? item._tag : item.message._tag}`),
          ),
        ),
        Effect.forkScoped,
      );
      yield* until(() => told.includes("pc Snapshot") && told.includes("bare Lost"));
      yield* Deferred.succeed(changes, undefined);
      yield* Deferred.await(removed);
      yield* until(() => told.includes("vm Snapshot"));
      // Said once its route has ended, so nothing it said comes after.
      expect(told.filter((one) => one.startsWith("pc "))).toEqual(["pc Snapshot", "pc Removed"]);
      expect(closed).toEqual(["pc"]);
      // Installed now, and found at once rather than after the 2 s its second failure waits.
      yield* until(() => told.filter((one) => one === "bare Lost").length === 2);
      installed = true;
      const woken = yield* Clock.currentTimeMillis;
      yield* Deferred.succeed(later, undefined);
      yield* until(() => told.includes("bare Snapshot"));
      expect((yield* Clock.currentTimeMillis) - woken).toBeLessThan(1000);
      expect(closed).toEqual(["pc"]);
    }),
  ));

test.each([
  ["first", "0 millis"],
  ["second", "200 millis"],
] as const)(
  "removing the route that showed a Machine reached two ways, its board %s, shows it through the other",
  (_, slower) =>
    run(
      Effect.gen(function* () {
        const told: string[] = [];
        const route = (name: string): Route<Fake> => ({
          machine: { profile: `p-${name}`, name, target: `mk@${name}` },
          open: () =>
            Effect.succeed<Fake>({
              board: () =>
                Stream.fromEffect(
                  Effect.as(Effect.sleep(name === "a" ? slower : "0 millis"), snapshot("pc")),
                ).pipe(Stream.concat(Stream.never)),
            }),
          collie: () => Effect.die("not asked"),
        });
        const remove = yield* Deferred.make<void>();
        const removed = yield* Deferred.make<void>();
        yield* flockStream(
          [route("a"), route("b")],
          new Map(),
          "0.31.0",
          Stream.fromEffect(Deferred.await(remove)).pipe(
            Stream.map(() => ({ _tag: "Remove", profile: "p-a", done: removed }) as const),
          ),
        ).pipe(
          Stream.runForEach((item: FlockItem) =>
            Effect.sync(() =>
              told.push(`${item.machine.name} ${"_tag" in item ? item._tag : item.message._tag}`),
            ),
          ),
          Effect.forkScoped,
        );
        yield* until(() => told.includes("a Snapshot") && told.some((one) => one.startsWith("b ")));
        yield* Deferred.succeed(remove, undefined);
        yield* Deferred.await(removed);
        yield* until(
          () =>
            told.includes("a Removed") &&
            told.lastIndexOf("b Snapshot") > told.indexOf("a Removed"),
        );
      }),
    ),
);

test("a removed Machine leaves the board, its routes and what onboarding left of it", () => {
  const machine = { profile: "p-vm", name: "vm", target: "mk@vm" };
  const run: OnboardRun = {
    steps: [{ step: "system", title: "System", status: "needs_root", command: "sudo x" }],
    asked: null,
    ready: false,
    reason: null,
    at: 1,
  };
  const items: FlockItem[] = [
    { _tag: "Routed", machine: { profile: "local", name: "pc" } },
    { _tag: "Routed", machine },
    { machine: { ...machine, installation: "vm-1" }, message: snapshot("vm-1") },
    { _tag: "Onboarding", job: "j-1", machine, run },
  ];
  const before = items.reduce(applyItem, EMPTY_FLOCK);
  expect(machineRows(before)).toEqual([
    { profile: "local", name: "pc", target: null, state: "connecting", onboarded: null },
    { profile: "p-vm", name: "vm", target: "mk@vm", state: "live", onboarded: run },
  ]);
  const after = applyItem(before, { _tag: "Removed", machine });
  expect(after.machines.size).toBe(0);
  expect(machineRows(after).map(({ profile }) => profile)).toEqual(["local"]);
});

test("a Machine's row says what doctor finds of it, over what its last onboarding said", () =>
  run(
    Effect.gen(function* () {
      const machine = { profile: "p-vm", name: "vm", target: "mk@vm" };
      const envelope = {
        ok: false,
        error: {
          code: "operation_failed",
          message: "1 of 2 checks failed.",
          details: {
            ready: false,
            checks: [
              { name: "herdr", ok: true, detail: "0.9.0", fix: "" },
              {
                name: "claude login",
                ok: false,
                detail: "not logged in",
                fix: "claude auth login",
              },
            ],
          },
        },
      };
      const route = {
        collie: (args: ReadonlyArray<string>) =>
          args.join(" ") === "--json doctor"
            ? Effect.succeed({ out: `${JSON.stringify(envelope)}\n`, err: "", code: 1 })
            : Effect.die(`asked ${args.join(" ")}`),
      };
      const doctored = Option.getOrThrow(yield* doctorOn(route));
      expect(doctored.ready).toBe(false);
      expect(doctored.steps).toEqual([
        {
          step: "claude-login",
          title: "claude login",
          status: "failed",
          detail: "not logged in",
          command: "claude auth login",
        },
      ]);
      const onboarded: OnboardRun = { steps: [], asked: null, ready: true, reason: null, at: 1 };
      const items: FlockItem[] = [
        { _tag: "Routed", machine },
        { _tag: "Onboarding", job: "j-1", machine, run: onboarded },
        { _tag: "Doctored", machine, run: doctored },
      ];
      expect(machineRows(items.reduce(applyItem, EMPTY_FLOCK))[0]!.onboarded).toEqual(doctored);
      const silent = { collie: () => Effect.fail("collie: not found") };
      expect(Option.isNone(yield* doctorOn(silent))).toBe(true);
    }),
  ));

test("Helle and the Linear MCP count toward onboarded though doctor passes them, unless onboarding skipped them", () =>
  run(
    Effect.gen(function* () {
      const machine = { profile: "p-vm", name: "vm", target: "mk@vm" };
      const said = (checks: ReadonlyArray<object>) => ({
        collie: () =>
          Effect.succeed({
            out: JSON.stringify({ ok: true, data: { ready: true, checks } }),
            err: "",
            code: 0,
          }),
      });
      const absent = [
        { name: "herdr", ok: true, detail: "0.9.0", fix: "" },
        { name: "helle", ok: true, detail: "no credentials", fix: "give Helle's credentials" },
        { name: "linear mcp", ok: true, detail: "logged in", fix: "" },
      ];
      const doctored = Option.getOrThrow(yield* doctorOn(said(absent)));
      expect(doctored.steps.map(({ step, status }) => [step, status])).toEqual([
        ["helle", "needs_human"],
      ]);
      const onboarding = (status: OnboardStep["status"]): OnboardRun => ({
        steps: [{ step: "helle", title: "Helle's credentials", status }],
        asked: null,
        ready: status === "skipped",
        reason: null,
        at: 0,
      });
      const row = (run: OnboardRun) => {
        const items: FlockItem[] = [
          { _tag: "Routed", machine },
          { _tag: "Onboarding", job: "j-1", machine, run },
          { _tag: "Doctored", machine, run: doctored },
        ];
        return machineRows(items.reduce(applyItem, EMPTY_FLOCK))[0]!.onboarded!;
      };
      expect(row(onboarding("needs_human")).ready).toBe(false);
      expect(row(onboarding("skipped")).ready).toBe(true);
      const working = absent.map((check) =>
        check.name === "helle" ? { ...check, detail: "as mk", fix: "" } : check,
      );
      expect(Option.getOrThrow(yield* doctorOn(said(working))).ready).toBe(true);
    }),
  ));
