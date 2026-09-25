// Every host a test starts ends with that test.
//
// A host is started detached, to outlive the client that needed it, so one a test forgot
// is reparented to PID 1 and serves a deleted directory for days. Each test file gets a
// temporary root of its own and every host it starts is told to live no longer than this
// process; a host whose directory goes stops by itself. After every test, a host still
// holding a directory under that root is killed and fails the test that left it.

import { afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), `collie-test-${process.pid}-`));
process.env.TMPDIR = root;
process.env.COLLIE_HOST_WATCH_PID = String(process.pid);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone already, which is what this is for.
  }
};

afterEach(async () => {
  // A host told to stop is still exiting for a moment after it lets its lock go. Well
  // inside the hook's own timeout, so what is left is reported rather than timed out.
  const deadline = Date.now() + 2_500;
  let left = hosts();
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    left = hosts();
  }
  if (left.length === 0) return;
  for (const one of left) kill(one.pid);
  throw new Error(
    `${left.length} host(s) outlived the test that started them: ${left.map((one) => `pid ${one.pid} on ${one.dir}`).join("; ")}`,
  );
});

process.on("exit", () => {
  for (const one of hosts()) kill(one.pid);
  rmSync(root, { recursive: true, force: true });
});
