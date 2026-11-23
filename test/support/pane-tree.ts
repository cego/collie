import * as Str from "effect/String";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// WARNING: ignores SIGTERM, so only a SIGKILL ends it.
export const IGNORES_TERM = "(trap '' TERM; exec sleep 600)";
export const SURVIVES_HANGUP = "sleep 600";

// WARNING: the shell is a session of its own, as a pty's is; the child is one a closed pane's hang-up does not reach.
export const paneTree = (child: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const shell = yield* spawner.spawn(
      ChildProcess.make("sh", ["-c", `${child} & echo $!; wait`], {
        detached: true,
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const line = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(shell.stdout)));
    const tree = {
      shell: shell.pid,
      child: Number(Str.trim(line._tag === "Some" ? line.value : "")),
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const pid of [tree.child, tree.shell]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }),
    );
    return tree;
  });
