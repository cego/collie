// `bun run tools/sign.ts <file>...`: writes `<file>.sig` beside each release asset, signed
// with the key in COLLIE_SIGNING_KEY, and checks it against the key built into Collie so a
// release signed by any other key fails here rather than at every install. Desktop's update
// archive is also signed as the tar it is applied as, which is what Desktop verifies.

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Data, Effect, FileSystem, Option } from "effect";
import { appliedSignatureOf, SIGNATURE_SUFFIX, signRelease, verifyRelease } from "../src/signing";

class SigningRefused extends Data.TaggedError("SigningRefused")<{ readonly message: string }> {}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const key = yield* Config.option(Config.String("COLLIE_SIGNING_KEY"));
  if (Option.isNone(key) || key.value === "") {
    return yield* new SigningRefused({
      message: "COLLIE_SIGNING_KEY is not set; a release is never published unsigned",
    });
  }
  const signed = Effect.fn(function* (bytes: Uint8Array, file: string, signaturePath: string) {
    const signature = signRelease(bytes, key.value);
    if (!verifyRelease(bytes, signature).ok) {
      return yield* new SigningRefused({
        message: `${file}: COLLIE_SIGNING_KEY is not the key Collie verifies with`,
      });
    }
    yield* fs.writeFileString(signaturePath, `${signature}\n`);
    yield* Effect.log(`signed ${file} as ${signaturePath}`);
  });
  for (const file of process.argv.slice(2)) {
    const bytes = yield* fs.readFile(file);
    yield* signed(bytes, file, `${file}${SIGNATURE_SUFFIX}`);
    const applied = appliedSignatureOf(file);
    if (applied !== null) yield* signed(Bun.zstdDecompressSync(bytes), file, applied);
  }
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
