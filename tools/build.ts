// WARNING: bun build --compile cannot run bundler plugins, so the release build is this script.
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
import { RELEASE_TREE } from "./release-tree";
import hcPin from "../hc-pin.json";

// WARNING: bun's musl targets are their own; libc only picks the native renderer to embed, never the target.
function bunTarget(name: string, libc: "musl" | "glibc") {
  const full = Str.startsWith("bun-")(name) ? name : `bun-${name}`;
  return libc === "musl" && Str.includes("-linux-")(full) && !Str.endsWith("-musl")(full)
    ? `${full}-musl`
    : full;
}

// WARNING: a build-time define, not a runtime read; otherwise both native libraries are embedded, 6 MB unused.
const libcConfig = Config.String("OPENTUI_LIBC").pipe(Config.withDefault(""));
const hcReleasesConfig = Config.String("COLLIE_HC_RELEASES_URL").pipe(
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

// WARNING: nothing on the build runner can run a cross-built binary to prove its renderer; the asset key is the proof.
function nativeMarker(target: string, libc: "musl" | "glibc") {
  const [, platform = "", arch = ""] = Str.split(target, "-");
  if (platform === "darwin") return `@opentui/core-darwin-${arch}/libopentui.dylib`;
  const suffix = platform === "linux" && libc === "musl" ? "-musl" : "";
  return `@opentui/core-${platform}-${arch}${suffix}/libopentui.so`;
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const args = yield* (yield* Stdio.Stdio).args;
  const libc = (yield* libcConfig) === "musl" ? "musl" : "glibc";
  const target = yield* Schema.decodeUnknownEffect(Target)(
    bunTarget(args[0] ?? `${process.platform}-${process.arch}`, libc),
  );
  const outfile = args[1] ?? "bin/collie";
  // WARNING: renaming a sibling keeps the executable bit and never overwrites a running runner in place.
  const staging = `${outfile}.new`;
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
      // WARNING: the host's door runs on a Worker, so the binary carries its entry too.
      entrypoints: ["src/main.ts", "src/door.ts"],
      target: "bun",
      plugins: [solidPlugin],
      define: { "process.env.OPENTUI_LIBC": libcDefine },
      // WARNING: bytecode for startup speed; ESM, since the renderer uses top-level await.
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
