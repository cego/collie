// How many workers `bun run test` starts: one for each core nothing else is using, so a
// suite on an idle machine uses all of it and several Runs each running this suite share
// what is left. Never fewer than four, which is what an idle machine used to get; a test's
// timeout is a hang's, not a busy machine's, so a slower worker is never a failing one.
import { availableParallelism, loadavg } from "node:os";

const cores = availableParallelism();
const idle = Math.round(Math.max(0, cores - loadavg()[0]));
console.log(Math.min(cores, Math.max(4, idle)));
