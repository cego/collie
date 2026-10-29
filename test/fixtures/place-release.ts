// One placement in a process of its own: `bun place-release.ts <tree> <runner> <collieDir> <version>`.
import { Effect } from "effect";
import { platformLayer } from "../../src/platform";
import { placeLocked } from "../../src/operations";

const [tree = "", runner = "", collieDir = "", version = ""] = process.argv.slice(2);
await Effect.runPromise(
  placeLocked({ tree, runner }, collieDir, version).pipe(Effect.provide(platformLayer)),
);
