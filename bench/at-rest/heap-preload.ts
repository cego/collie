/* oxlint-disable effecttsgo/node-builtin-import -- preloaded before the host's Effect runtime exists. */

import { heapStats } from "bun:jsc";
import { renameSync, writeFileSync } from "node:fs";

const file = Bun.env.BENCH_HEAP_FILE;
if (file !== undefined)
  process.on("SIGUSR2", () => {
    Bun.gc(true);
    const stats = heapStats();
    writeFileSync(
      `${file}.part`,
      JSON.stringify({ heap_kb: Math.round(stats.heapSize / 1024), objects: stats.objectCount }),
    );
    renameSync(`${file}.part`, file);
  });
