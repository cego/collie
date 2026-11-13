// The process a host runs a check's command under, outside the host's process group, so the
// check outlives a host that hands it over (ADR-draft-a-check-ends-with-the-host-that-runs-it,
// D5). It holds the command's pipes, writes the check's log, relays both streams to the host,
// and once both close and the command has exited, writes each stream's end and then the exit
// status to the check's files, which any host on the state directory finishes it from.

import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The first argument that makes `collie` a check's supervisor. */
export const SUPERVISE = "supervise-check";

/** How much of a check's output its log keeps; what comes after is cut, and the log says so. */
export const LOG_BYTES = 8 * 1024 * 1024;
/** Enough of a stream's end for its last 4 KiB of characters. */
export const KEPT_BYTES = 16 * 1024;

/** What of `chunk` a log that already holds `already` bytes takes, and how many it then holds. */
export const logged = (chunk: string, already: number) => {
  if (already > LOG_BYTES) return { text: "", logged: already };
  const bytes = Buffer.byteLength(chunk, "utf8");
  const room = LOG_BYTES - already;
  const text =
    bytes <= room
      ? chunk
      : `${Buffer.from(chunk, "utf8").subarray(0, room).toString("utf8")}\n[collie: the output was cut at ${LOG_BYTES} bytes; the rest was not kept]\n`;
  return { text, logged: already + bytes };
};

/** A check's files under `outputs`, its output directory. */
export const checkFiles = (outputs: string, id: string) => ({
  stdout: `${outputs}/${id}.stdout`,
  stderr: `${outputs}/${id}.stderr`,
  pid: `${outputs}/${id}.pid`,
  exit: `${outputs}/${id}.exit`,
});

type Name = "stdout" | "stderr";

/** Runs `[executable, ...argv]` for check `id`, logging to `log` unless it is empty. */
export const supervise = Effect.fn("CheckSupervisor.supervise")(function* ([
  outputs = "",
  id = "",
  log = "",
  ...command
]: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The host that reads these may be gone; the check goes on without it.
  const relays = { stdout: process.stdout, stderr: process.stderr };
  for (const stream of [relays.stdout, relays.stderr]) stream.on("error", () => {});
  const kept = { stdout: new Uint8Array(), stderr: new Uint8Array() };
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let already = 0;
  const files = checkFiles(outputs, id);
  const whole = (path: string, data: Uint8Array) =>
    fs.writeFile(`${path}.new`, data).pipe(
      Effect.andThen(fs.rename(`${path}.new`, path)),
      Effect.tapError(() => fs.remove(`${path}.new`, { force: true }).pipe(Effect.ignore)),
    );
  // Its stderr needs no disk to reach the host, and lands in the check's log and tail.
  const finish = (path: string, data: Uint8Array) =>
    whole(path, data).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          relays.stderr.write(`collie: could not write ${path}: ${error.message}\n`),
        ),
      ),
    );
  const take = (name: Name, chunk: Uint8Array) =>
    Effect.gen(function* () {
      kept[name] = Buffer.concat([kept[name], chunk]).subarray(-KEPT_BYTES);
      relays[name].write(chunk);
      if (log === "") return;
      const next = logged(decoders[name].decode(chunk, { stream: true }), already);
      already = next.logged;
      if (next.text !== "")
        yield* fs.writeFileString(log, next.text, { flag: "a" }).pipe(Effect.ignore);
    });
  const exit = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command[0] ?? "", command.slice(1), {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: true,
          // In this supervisor's group, which a host ends as the check's.
          detached: false,
        }),
      );
      yield* whole(files.pid, Buffer.from(String(handle.pid))).pipe(Effect.ignore);
      const tagged = (name: Name) => Stream.map(handle[name], (chunk) => ({ name, chunk }));
      // One stream, so the log takes the two in the order they arrived.
      yield* Stream.merge(tagged("stdout"), tagged("stderr")).pipe(
        Stream.runForEach(({ name, chunk }) => take(name, chunk)),
      );
      return Number(yield* handle.exitCode);
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const said = `collie: could not run ${command[0]}: ${String(cause)}\n`;
        yield* take("stderr", Buffer.from(said));
        return 127;
      }),
    ),
  );
  yield* finish(files.stdout, kept.stdout);
  yield* finish(files.stderr, kept.stderr);
  yield* finish(files.exit, Buffer.from(String(exit)));
});
