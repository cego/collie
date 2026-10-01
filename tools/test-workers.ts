// How many workers `bun run test` starts: four on an idle machine, fewer the busier it
// already is, so several Runs each running this suite do not starve it into timeouts. Never
// one: the suite has never passed on a single worker, which is what a busy CI runner chose.
import { availableParallelism, loadavg } from "node:os";

const cores = availableParallelism();
const idle = Math.max(0, cores - loadavg()[0]) / cores;
console.log(Math.max(2, Math.round(4 * idle)));
