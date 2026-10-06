// herdr as Desktop's tests script it, over `<flock>/machines.json`: `machine list --json`
// prints it; `machine add` asks whether to replace the running server, as herdr does of an
// incompatible one, logs the answer to `<flock>/herdr.log` and saves the machine;
// `machine remove <id>` logs that and drops it.
//
// Usage: bun scripted-herdr.ts <flock> machine list --json | add … <target> | remove <id>

import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";

const [flock, ...args] = Bun.argv.slice(2);
const file = `${flock}/machines.json`;
const asked = args.join(" ");
const Machines = Schema.fromJsonString(
  Schema.Array(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean]))),
);
const after = (flag: string) => args[args.indexOf(flag) + 1]!;

const firstLine = Stream.fromReadableStream({
  evaluate: () => Bun.stdin.stream(),
  onError: String,
}).pipe(
  Stream.decodeText(),
  Stream.splitLines,
  Stream.runHead,
  Effect.map(Option.match({ onNone: () => "", onSome: (line) => line.trim() })),
);

const herdr = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const machines = [
    ...(yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Machines)))),
  ];
  const save = Effect.suspend(() =>
    fs
      .writeFileString(`${file}.new`, Schema.encodeSync(Machines)(machines))
      .pipe(Effect.andThen(fs.rename(`${file}.new`, file))),
  );
  const log = (line: string) =>
    fs.writeFileString(`${flock}/herdr.log`, `${line}\n`, { flag: "a" });
  if (asked === "machine list --json") {
    process.stdout.write(Schema.encodeSync(Machines)(machines));
    return 0;
  }
  if (asked.startsWith("machine add ")) {
    const target = args.at(-1)!;
    process.stdout.write(
      "The remote server is incompatible. Stop and replace the running server now? [y/N] ",
    );
    const answer = yield* firstLine;
    yield* log(`add ${target} replace=${answer}`);
    const id = `added-${after("--label")}`;
    machines.push({
      id,
      label: after("--label"),
      target,
      session: after("--remote-session"),
      enabled: true,
      selected: false,
    });
    yield* save;
    process.stdout.write(`Saved SSH machine ${id}.\n`);
    return 0;
  }
  if (asked.startsWith("machine remove ")) {
    yield* log(`remove ${args.at(-1)}`);
    const at = machines.findIndex(({ id }) => id === args.at(-1));
    if (at === -1) return 1;
    machines.splice(at, 1);
    yield* save;
    return 0;
  }
  return 2;
});

herdr.pipe(
  Effect.flatMap((code) => Effect.sync(() => process.exit(code))),
  Effect.orDie,
  Effect.provide(BunFileSystem.layer),
  BunRuntime.runMain,
);
