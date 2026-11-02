// The release build. `bun build --compile` cannot run bundler plugins, and Solid needs
// its JSX transform, so the build is a script: `bun run tools/build.ts [target]
// [outfile]`. Every release artifact and the local `bun run build` come through here,
// so the plugin, the libc pin and the renderer gate below cannot drift apart.

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Array as Arr,
  Cause,
  Config,
  Console,
  Effect,
  FileSystem,
  Path,
  Schema,
  Stdio,
  String as Str,
} from "effect";
import solidPlugin from "@opentui/solid/bun-plugin";
import { bundleHc } from "./hc-release";
import hcPin from "../hc-pin.json";

/**
 * `linux-x64` and `bun-linux-x64` both name the same target; CI passes the short one.
 * Bun's musl targets are their own — `bun-linux-x64-musl` — and the libc below only ever
 * decided which native renderer to embed, so a musl machine building from source got a
 * glibc-linked executable it could not run, which is not what it asked for.
 */
function bunTarget(name: string, libc: "musl" | "glibc"): string {
  const full = Str.startsWith("bun-")(name) ? name : `bun-${name}`;
  return libc === "musl" && Str.includes("-linux-")(full) && !Str.endsWith("-musl")(full)
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
const libcConfig = Config.String("OPENTUI_LIBC").pipe(Config.withDefault(""));
/** Where hc's releases are fetched from: upstream's, unless a test serves its own. */
const hcReleasesConfig = Config.String("HERDR_RELEASES_URL").pipe(
  Config.withDefault("https://releases.herdr.dev"),
);

const Architecture = Schema.Literals(["x64", "arm64", "aarch64"]);
const Simd = Schema.Literals(["baseline", "modern"]);
const Target = Schema.Union([
  Schema.TemplateLiteral(["bun-darwin-", Architecture]),
  Schema.TemplateLiteral(["bun-darwin-", Architecture, "-", Simd]),
  Schema.TemplateLiteral(["bun-linux-", Architecture]),
  Schema.TemplateLiteral(["bun-linux-", Architecture, "-", Schema.Literals(["glibc", "musl"])]),
  Schema.TemplateLiteral(["bun-linux-", Architecture, "-", Simd]),
  Schema.TemplateLiteral([
    "bun-linux-",
    Architecture,
    "-",
    Simd,
    "-",
    Schema.Literals(["glibc", "musl"]),
  ]),
  Schema.TemplateLiteral(["bun-windows-", Architecture]),
  Schema.TemplateLiteral(["bun-windows-x64-", Simd]),
]);

/**
 * The native renderer a given target must end up carrying. `@opentui/core` picks its
 * library with an `await import` per platform, so a cross-build that resolved the wrong
 * optional package produces a binary that dies on first render on the machine it was
 * built for — and nothing on the build runner can execute it to find out. The asset key
 * below is the name the bundler registers the embedded library under, so its presence in
 * the artifact is the proof; it appears in no other target's binary.
 */
function nativeMarker(target: string, libc: "musl" | "glibc"): string {
  const [, platform = "", arch = ""] = Str.split(target, "-");
  if (platform === "darwin") return `@opentui/core-darwin-${arch}/libopentui.dylib`;
  const suffix = platform === "linux" && libc === "musl" ? "-musl" : "";
  return `@opentui/core-${platform}-${arch}${suffix}/libopentui.so`;
}

/** What an Installation reads at runtime, placed by the runner as `release/`. */
const RELEASE_TREE = [
  "herdr-plugin.toml",
  "install.sh",
  "prepare.sh",
  "release-p256.pub",
  "workflows",
  "personas",
  "prompts",
  "skills/collie",
  "assets/brand/logos/collie-horizontal-light-512.png",
];
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const args = yield* (yield* Stdio.Stdio).args;
  const libc = (yield* libcConfig) === "musl" ? "musl" : "glibc";
  const target = yield* Schema.decodeUnknownEffect(Target)(
    bunTarget(args[0] ?? `${process.platform}-${process.arch}`, libc),
  );
  const outfile = args[1] ?? "bin/collie";
  // Renaming a sibling preserves the executable bit and never overwrites a running runner in place.
  const staging = `${outfile}.new`;
  // Named `release` because the embedded directory keeps its basename: `/$bunfs/root/release`.
  const tree = paths.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "collie-build-" }),
    "release",
  );
  for (const entry of RELEASE_TREE)
    yield* fs.copy(entry, paths.join(tree, entry), { overwrite: true });
  const hc = yield* bundleHc(hcPin, target, tree, {
    releases: yield* hcReleasesConfig,
    cache: "node_modules/.cache/collie-hc",
  });
  const entries = yield* fs.readDirectory(tree, { recursive: true });
  const files = yield* Effect.filter(entries, (entry) =>
    fs.lstat(paths.join(tree, entry)).pipe(Effect.map((info) => info.type === "File")),
  );
  const carried = Arr.map(files, (entry) => `release/${entry}`);
  const libcDefine = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(libc);

  yield* Effect.promise(() =>
    Bun.build({
      entrypoints: ["src/main.ts"],
      target: "bun",
      plugins: [solidPlugin],
      define: { "process.env.OPENTUI_LIBC": libcDefine },
      // Bytecode starts faster; ESM supports the renderer's top-level await.
      bytecode: true,
      format: "esm",
      compile: { target, outfile: staging, assets: [tree] },
    }),
  );

  const marker = nativeMarker(target, libc);
  const artifact = Buffer.from(yield* fs.readFile(staging));
  const missing = Arr.filter([marker, ...carried], (name) => !artifact.includes(name));
  if (!artifact.includes(hc)) missing.push(`hc ${hcPin.version}'s archive as pinned`);
  if (missing.length > 0) {
    yield* fs.remove(staging);
    return yield* Effect.die(
      new Error(
        `${target}: the artifact does not embed ${Arr.join(missing, ", ")}; not shipping it`,
      ),
    );
  }

  yield* fs.rename(staging, outfile);
  yield* Console.log(
    `built ${outfile} for ${target}, embedding ${marker}, hc ${hcPin.version} and ${carried.length} release files`,
  );
});

BunRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.tapCause((cause) => Console.error(Cause.pretty(cause))),
    Effect.provide(BunServices.layer),
  ),
  { disableErrorReporting: true },
);
