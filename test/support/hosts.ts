import * as Arr from "effect/Array";
import * as Struct from "effect/Struct";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import { afterAll, afterEach, beforeAll, beforeEach, setDefaultTimeout } from "bun:test";
import { Clock, Effect, Path, Schedule } from "effect";
/* oxlint-disable effecttsgo/process-env */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"; // oxlint-disable-line effecttsgo/node-builtin-import
const { dirname, join, relative } = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
import { GIT_QUIET } from "./git-quiet";
import { alive, kill, MARKER, marked, rootBase } from "./sweep";
import { testBunfig } from "./packages";

setDefaultTimeout(30_000);

const base = rootBase();
let root = "";
const makeRoot = () => {
  root = mkdtempSync(join(base, `collie-test-${process.pid}-`));
  process.env.TMPDIR = root;
  process.env[MARKER] = root;
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME);
  writeFileSync(join(process.env.HOME, ".bunfig.toml"), testBunfig);
  writeFileSync(
    join(process.env.HOME, ".gitconfig"),
    "[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n",
  );
};
makeRoot();
const nameTestFile = () => {
  process.env.COLLIE_TEST_FILE = relative(new URL("../..", import.meta.url).pathname, Bun.main);
};
nameTestFile();
Object.assign(process.env, GIT_QUIET);
process.env.COLLIE_HOST_WATCH_PID = String(process.pid);
process.env.COLLIE_HOST_STOP_GRACE ??= "500 millis";
for (const key of Struct.keys(process.env))
  if (pipe(key, Str.startsWith("HERDR_"))) delete process.env[key];
delete process.env.COLLIE_USER_DIR;
delete process.env.COLLIE_STATE_DIR;
delete process.env.COLLIE_ROOT;
process.env.HC_SOCKET = "/nonexistent/collie-test/hc.sock";
delete process.env.HC_SESSION;
process.env.COLLIE_RELEASES = "http://127.0.0.1:9";
delete process.env.COLLIE_CWD;
delete process.env.XDG_CONFIG_HOME;
process.env.BUN_INSTALL_CACHE_DIR = new URL(
  "../../.scratch/test-packages",
  import.meta.url,
).pathname;
const proc = new URL("../../.scratch/test-proc", import.meta.url).pathname;
mkdirSync(join(proc, "pressure"), { recursive: true });
writeFileSync(join(proc, "meminfo"), "MemTotal: 104857600 kB\nMemAvailable: 52428800 kB\n");
writeFileSync(
  join(proc, "pressure", "memory"),
  "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
);
process.env.COLLIE_PROC = proc;

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Bun overloads have different argument/result types; the forwarding shim treats them as opaque.
type Spawn = (first: unknown, options?: { env?: unknown }) => unknown;
const inherit = <F extends typeof Bun.spawn | typeof Bun.spawnSync>(spawn: F) => {
  // WARNING: only Bun's spawn functions enter this adapter, with their original receiver-free arguments.
  const call = spawn as Spawn;
  // WARNING: each overload's result is returned unchanged; only the default environment is replaced.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  return ((first: unknown, options?: { env?: unknown }) =>
    Arr.isArray(first)
      ? call(first, { ...options, env: options?.env ?? process.env })
      : call({ ...(first as object), env: (first as { env?: unknown }).env ?? process.env })) as F;
};
Bun.spawn = inherit(Bun.spawn);
Bun.spawnSync = inherit(Bun.spawnSync);

const hosts = () =>
  Arr.flatMap(
    [
      ...new Bun.Glob("**/host.lock").scanSync({
        cwd: root,
        dot: true,
        absolute: true,
      }),
    ],
    (lock) => {
      const pid = Number(
        Option.getOrUndefined(
          Option.map(
            Option.fromNullishOr(/"pid":\s*(\d+)/.exec(readFileSync(lock, "utf8"))),
            (present) => present[1],
          ),
        ) ?? 0,
      );
      return pid > 0 && pid !== process.pid && alive(pid)
        ? [
            {
              pid,
              dir: dirname(lock),
            },
          ]
        : [];
    },
  );

const entries = () => Arr.filter(readdirSync(root), (name) => name !== "home");

const settled = <A>(find: () => ReadonlyArray<A>) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 2_500;
    return yield* Effect.sync(find).pipe(
      Effect.repeat({
        until: (left) => left.length === 0,
        schedule: Schedule.spaced(100).pipe(Schedule.while(({ now }) => now < deadline)),
      }),
    );
  });

beforeAll(() => {
  if (!existsSync(root)) makeRoot();
});

let before = new Set<string>();
beforeEach(() => {
  nameTestFile();
  before = new Set(entries());
});

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const left = yield* settled(hosts);
      for (const one of left) kill(one.pid);
      const made = Arr.filter(entries(), (name) => !before.has(name));
      for (const name of made) rmSync(join(root, name), { recursive: true, force: true });
      const problems = [
        ...Arr.map(left, (one) => `host pid ${one.pid} on ${one.dir}`),
        ...Arr.map(made, (name) => `directory ${join(root, name)}`),
      ];
      if (problems.length > 0)
        return yield* Effect.die(
          new Error(
            `The test left ${problems.length} thing(s) behind: ${Arr.join(problems, "; ")}`,
          ),
        );
    }),
  ),
);

afterAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const left = yield* settled(() => marked(root));
      for (const one of left) kill(one.pid);
      const made = entries();
      rmSync(root, { recursive: true, force: true });
      const problems = [
        ...Arr.map(left, (one) => `process pid ${one.pid} (${one.command})`),
        ...Arr.map(made, (name) => `directory ${join(root, name)}`),
      ];
      if (problems.length > 0)
        return yield* Effect.die(
          new Error(
            `The file left ${problems.length} thing(s) behind: ${Arr.join(problems, "; ")}`,
          ),
        );
    }),
  ),
);

process.on("exit", () => {
  for (const one of hosts()) kill(one.pid);
  rmSync(root, { recursive: true, force: true });
});
