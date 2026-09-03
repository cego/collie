// The release build. `bun build --compile` cannot run bundler plugins, and Solid needs
// its JSX transform, so the build is a script: `bun run tools/build.ts [target]
// [outfile]`. Every release artifact and the local `bun run build` come through here,
// so the plugin, the libc pin and the renderer gate below cannot drift apart.

import { readFileSync, renameSync, rmSync } from "node:fs";
import solidPlugin from "@opentui/solid/bun-plugin";

/**
 * `linux-x64` and `bun-linux-x64` both name the same target; CI passes the short one.
 * Bun's musl targets are their own — `bun-linux-x64-musl` — and the libc below only ever
 * decided which native renderer to embed, so a musl machine building from source got a
 * glibc-linked executable it could not run, which is not what it asked for.
 */
function bunTarget(name: string): string {
  const full = name.startsWith("bun-") ? name : `bun-${name}`;
  return libc === "musl" && full.includes("-linux-") && !full.endsWith("-musl")
    ? `${full}-musl`
    : full;
}

/**
 * Which linux C library the artifact is for. `@opentui/core` reads this at *runtime* to
 * pick its package, so both branches are reachable to the bundler and both native
 * libraries get embedded — 6 MB of the artifact for one that will never load. Pinned as
 * a build-time define instead. The releases are glibc; a musl machine building from
 * source sets `OPENTUI_LIBC=musl` and gets its own.
 */
const libc = process.env.OPENTUI_LIBC === "musl" ? "musl" : "glibc";

/**
 * The native renderer a given target must end up carrying. `@opentui/core` picks its
 * library with an `await import` per platform, so a cross-build that resolved the wrong
 * optional package produces a binary that dies on first render on the machine it was
 * built for — and nothing on the build runner can execute it to find out. The asset key
 * below is the name the bundler registers the embedded library under, so its presence in
 * the artifact is the proof; it appears in no other target's binary.
 */
function nativeMarker(target: string): string {
  const [, platform = "", arch = ""] = target.split("-");
  if (platform === "darwin") return `@opentui/core-darwin-${arch}/libopentui.dylib`;
  const suffix = platform === "linux" && libc === "musl" ? "-musl" : "";
  return `@opentui/core-${platform}-${arch}${suffix}/libopentui.so`;
}

const target = bunTarget(Bun.argv[2] ?? `${process.platform}-${process.arch}`);
const outfile = Bun.argv[3] ?? "bin/collie";
// Build beside the binary and rename over it: replacing a running runner's own file in
// place kills the process executing it. `collie upgrade` runs from that very binary, so
// this is the load-bearing half of being able to upgrade at all.
const staging = `${outfile}.new`;

await Bun.build({
  entrypoints: ["src/main.ts"],
  target: "bun",
  plugins: [solidPlugin],
  define: { "process.env.OPENTUI_LIBC": JSON.stringify(libc) },
  compile: { target, outfile: staging },
});

const marker = nativeMarker(target);
if (!readFileSync(staging).includes(marker)) {
  rmSync(staging);
  throw new Error(`${target}: the artifact does not embed ${marker}; not shipping it`);
}

// `renameSync`, not a copy: it is atomic and it keeps the executable bit compile set on it.
renameSync(staging, outfile);
console.log(`built ${outfile} for ${target}, embedding ${marker}`);
