#!/usr/bin/env bun
// The fake forge as a CLI, for the processes a test actually spawns; see forge.ts.

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Schema } from "effect";
import { recordStart } from "../../src/starts";
import { forgeBin } from "./forge";

const [forge = "", file = "", ...args] = Bun.argv.slice(2);
await Effect.runPromise(
  recordStart(`forge ${forge}`, args).pipe(Effect.provide(BunFileSystem.layer)),
);
const { code, stdout } = await Effect.runPromise(
  forgeBin(Schema.decodeUnknownSync(Schema.Literals(["gitlab", "github"]))(forge), file, args).pipe(
    Effect.provide(BunFileSystem.layer),
  ),
);
if (stdout) await Bun.write(Bun.stdout, stdout);
globalThis.process.exitCode = code;
