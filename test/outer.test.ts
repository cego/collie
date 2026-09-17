import { Effect, FileSystem } from "effect";
import { expect, test } from "bun:test";
import { attachedTerms, everyViewerPaints, paintsGraphics } from "../src/outer";
import { runEffect } from "./support/effect";

test("the terminals that paint Kitty graphics are named, and Alacritty is not one", () => {
  expect(paintsGraphics("xterm-ghostty")).toBe(true);
  expect(paintsGraphics("xterm-kitty")).toBe(true);
  expect(paintsGraphics("alacritty")).toBe(false);
  expect(paintsGraphics("xterm-256color")).toBe(false);
});

/** A /proc with the given processes: command line and environment per pid. */
const fakeProc = Effect.fn("test.fakeProc")(function* (
  procs: ReadonlyArray<{ cmdline: string[]; term: string | null }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectory({ prefix: "collie-proc-" });
  let pid = 100;
  for (const proc of procs) {
    const dir = `${root}/${pid++}`;
    yield* fs.makeDirectory(dir);
    yield* fs.writeFileString(`${dir}/cmdline`, `${proc.cmdline.join("\0")}\0`);
    yield* fs.writeFileString(
      `${dir}/environ`,
      `HOME=/home/x\0${proc.term === null ? "" : `TERM=${proc.term}\0`}PATH=/bin\0`,
    );
  }
  yield* fs.writeFileString(`${root}/uptime`, "1 1");
  return root;
});

test("only attached clients count, and every one of them has to paint", () =>
  runEffect(
    Effect.gen(function* () {
      // A server and a CLI call are not viewers, whatever their TERM says.
      const one = yield* fakeProc([
        { cmdline: ["/home/x/.local/bin/herdr", "server"], term: "xterm-256color" },
        { cmdline: ["herdr", "pane", "list"], term: "alacritty" },
        { cmdline: ["herdr"], term: "xterm-ghostty" },
      ]);
      expect(yield* attachedTerms(one)).toEqual(["xterm-ghostty"]);
      expect(yield* everyViewerPaints(one)).toBe(true);

      // A second viewer on Alacritty would see a blank, so nobody gets the picture.
      const two = yield* fakeProc([
        { cmdline: ["herdr"], term: "xterm-ghostty" },
        { cmdline: ["herdr"], term: "alacritty" },
      ]);
      expect(yield* everyViewerPaints(two)).toBe(false);

      // No client at all — a board outside herdr, or a machine without /proc — draws none.
      expect(yield* everyViewerPaints(yield* fakeProc([]))).toBe(false);
      expect(yield* everyViewerPaints("/nowhere/proc")).toBe(false);
    }),
  ));
