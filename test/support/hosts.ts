// A test file leaves nothing behind.
//
// Each test file gets a temporary root of its own, removed when the file ends: `TMPDIR`
// points into it, and every process a test starts carries `COLLIE_TEST_ROOT` naming it.
// A host is started detached, to outlive the client that needed it, so every host a test
// starts is told to live no longer than this process, and one whose directory goes stops by
// itself. After every test, a host still holding a directory under the root is killed and
// whatever the test made directly under the root is removed; either fails the test. After
// the file, a process still carrying the marker is killed and fails the file, as does what
// a `beforeAll` made and left. A test that failed or timed out is cleaned up the same way.
//
// No HERDR_* but the contract check's HERDR_API_SCHEMA, and none of the operator's Collie
// directories, reach a test unless it sets them itself. HOME is the suite's own, so a suite
// run from a herdr pane cannot reach the live herd.

import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { alive, kill, MARKER, marked } from "./sweep";

const root = mkdtempSync(join(tmpdir(), `collie-test-${process.pid}-`));
process.env.TMPDIR = root;
process.env.COLLIE_HOST_WATCH_PID = String(process.pid);
// A stopped host waits this long for its steps before exiting; well inside `settled` below,
// so a host told to stop is gone before the check, not reported as left behind.
process.env.COLLIE_HOST_STOP_GRACE ??= "500 millis";
process.env[MARKER] = root;
for (const key of Object.keys(process.env))
  if (key.startsWith("HERDR_") && key !== "HERDR_API_SCHEMA") delete process.env[key];
delete process.env.COLLIE_USER_DIR;
delete process.env.COLLIE_CWD;
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME);

// Bun.spawn's default environment is the one this process started with, not process.env.
type Spawn = (first: unknown, options?: { env?: unknown }) => unknown;
const inherit = <F>(spawn: F) => {
  const call = spawn as Spawn;
  return ((first: unknown, options?: { env?: unknown }) =>
    Array.isArray(first)
      ? call(first, { ...options, env: options?.env ?? process.env })
      : call({ ...(first as object), env: (first as { env?: unknown }).env ?? process.env })) as F;
};
Bun.spawn = inherit(Bun.spawn);
Bun.spawnSync = inherit(Bun.spawnSync);

/**
 * Every live host holding a directory under this file's root, from the lock each one
 * holds: a scan of the test's own files rather than the machine's process table, which
 * is too slow to read after every test.
 */
const hosts = () =>
  [...new Bun.Glob("**/host.lock").scanSync({ cwd: root, dot: true, absolute: true })].flatMap(
    (lock) => {
      const pid = Number(/"pid":\s*(\d+)/.exec(readFileSync(lock, "utf8"))?.[1] ?? 0);
      return pid > 0 && pid !== process.pid && alive(pid) ? [{ pid, dir: dirname(lock) }] : [];
    },
  );

/** What is directly under the root, but the isolated home. */
const entries = () => readdirSync(root).filter((name) => name !== "home");

/**
 * What `find` still returns once a moment has passed: a host told to stop, or a process
 * whose directory went, is still exiting for a moment. Well inside a hook's own timeout,
 * so what is left is reported rather than timed out.
 */
const settled = async <A>(find: () => ReadonlyArray<A>) => {
  const deadline = Date.now() + 2_500;
  let left = find();
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    left = find();
  }
  return left;
};

let before = new Set<string>();
beforeEach(() => {
  before = new Set(entries());
});

afterEach(async () => {
  const left = await settled(hosts);
  for (const one of left) kill(one.pid);
  const made = entries().filter((name) => !before.has(name));
  for (const name of made) rmSync(join(root, name), { recursive: true, force: true });
  const problems = [
    ...left.map((one) => `host pid ${one.pid} on ${one.dir}`),
    ...made.map((name) => `directory ${join(root, name)}`),
  ];
  // Bun counts a test that already failed once, so this only adds what it left.
  if (problems.length > 0)
    throw new Error(`The test left ${problems.length} thing(s) behind: ${problems.join("; ")}`);
});

afterAll(async () => {
  const left = await settled(() => marked(root));
  for (const one of left) kill(one.pid);
  const made = entries();
  rmSync(root, { recursive: true, force: true });
  const problems = [
    ...left.map((one) => `process pid ${one.pid} (${one.command})`),
    ...made.map((name) => `directory ${join(root, name)}`),
  ];
  if (problems.length > 0)
    throw new Error(`The file left ${problems.length} thing(s) behind: ${problems.join("; ")}`);
});

process.on("exit", () => {
  for (const one of hosts()) kill(one.pid);
  rmSync(root, { recursive: true, force: true });
});
