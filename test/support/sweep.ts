// What a test file's root leaves behind, and how a killed suite's roots are removed.
//
// Every process a test starts carries `COLLIE_TEST_ROOT` naming its file's root, which is
// how a leftover is proved to be the suite's. Read from /proc, so Linux only.

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "COLLIE_TEST_ROOT";

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone already, which is what this is for.
  }
};

/** Every live process, other than this one, whose environment names `root` as its marker. */
export const marked = (root: string): ReadonlyArray<{ pid: number; command: string }> => {
  let pids: Array<string>;
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const want = `${MARKER}=${root}`;
  return pids.flatMap((name) => {
    const pid = Number(name);
    if (pid === process.pid) return [];
    try {
      if (!readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(want)) return [];
      const command = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim();
      return [{ pid, command }];
    } catch {
      return [];
    }
  });
};

/**
 * Removes every `collie-test-<pid>-*` root in `dir` whose pid is dead, and kills what still
 * carries its marker. A live pid's root is another suite's and is left alone.
 */
export const sweepDeadRoots = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    const pid = Number(/^collie-test-(\d+)-/.exec(name)?.[1] ?? 0);
    if (pid <= 0 || alive(pid)) return [];
    const root = join(dir, name);
    for (const one of marked(root)) kill(one.pid);
    rmSync(root, { recursive: true, force: true });
    return [root];
  });
