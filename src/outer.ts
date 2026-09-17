// Whether the human's own terminal — the one herdr is attached from — paints images.
//
// The Kitty graphics handshake cannot answer this: herdr parses graphics itself and
// answers "OK" whatever the terminal beyond it does, so a board that trusted the
// handshake drew nothing at all under Alacritty. What does answer is the attached
// client: `herdr` runs as a process on this machine, and its environment carries the
// outer terminal's TERM. Every attached client has to paint, because a viewer whose
// terminal does not would see a blank where the mark is.

import { Effect, FileSystem, Path } from "effect";

/** TERM values of terminals that implement the Kitty graphics protocol. */
const PAINTS: ReadonlySet<string> = new Set(["xterm-ghostty", "xterm-kitty", "wezterm"]);

export function paintsGraphics(term: string): boolean {
  return PAINTS.has(term);
}

/** The TERM of one process, or null where it has none or cannot be read. */
const termOf = Effect.fn("Outer.termOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const environ = yield* fs.readFileString(`${dir}/environ`);
  const found = environ.split("\0").find((entry) => entry.startsWith("TERM="));
  return found === undefined ? null : found.slice("TERM=".length);
});

/**
 * The TERMs of every attached herdr client on this machine: the processes whose command
 * line is exactly `herdr`, which is the client attaching to a server. Empty where /proc
 * is not there to read, which is every machine that is not Linux.
 */
export const attachedTerms = Effect.fn("Outer.attachedTerms")(function* (proc = "/proc") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(proc).pipe(Effect.catch(() => Effect.succeed([])));
  const terms: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = path.join(proc, entry);
    const cmdline = yield* fs
      .readFileString(`${dir}/cmdline`)
      .pipe(Effect.catch(() => Effect.succeed("")));
    // The client and only the client: `herdr server` and `herdr pane …` are not viewers.
    if (cmdline.replace(/\0+$/, "").split("\0").at(-1) !== "herdr") continue;
    const term = yield* termOf(dir).pipe(Effect.catch(() => Effect.succeed(null)));
    if (term !== null) terms.push(term);
  }
  return terms;
});

/** Whether a picture drawn in a pane reaches every human looking at it. */
export const everyViewerPaints = Effect.fn("Outer.everyViewerPaints")(function* (proc = "/proc") {
  const terms = yield* attachedTerms(proc);
  return terms.length > 0 && terms.every(paintsGraphics);
});
