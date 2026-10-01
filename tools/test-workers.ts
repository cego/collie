// How many workers `bun run test` starts: four on an idle machine, fewer the busier it
// already is, so several Runs each running this suite do not starve it into timeouts. Never
// fewer than two, the fewest the suite has been shown to pass on.
import { availableParallelism, loadavg } from "node:os";

const cores = availableParallelism();
const idle = Math.max(0, cores - loadavg()[0]) / cores;
console.log(Math.max(2, Math.round(4 * idle)));
