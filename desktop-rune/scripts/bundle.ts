// Builds the Rune spike's bundle for this computer, and the update archive and manifest a
// release would carry beside it (desktop-rune/README.md):
//
//   bun run desktop-rune/scripts/bundle.ts [out]   # out defaults to desktop-rune/dist
//
// On macOS it signs with ELECTROBUN_DEVELOPER_ID (ad hoc without one) and notarises with the
// release's Apple secrets, as Desktop's build does. The release signs the archive with
// tools/sign.ts, as it signs Desktop's.

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Cause, Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { MAC_ENTITLEMENTS, macSigning } from "../../desktop/scripts/mac-signing";
import manifest from "../../herdr-plugin.toml";

export type Os = "linux" | "macos";
type Env = Record<string, string | undefined>;

const ROOT = new URL("../../", import.meta.url).pathname;
const IDENTIFIER = "dk.cego.collie.desktop.rune";
const CHANNEL = "stable";
const BASE_URL = "https://github.com/cego/collie/releases/latest/download";

export const bundleNameOf = (os: Os) => (os === "macos" ? "Collie.app" : "collie-desktop");

/** Where each part sits inside the bundle. */
const layoutOf = (os: Os) =>
  os === "macos"
    ? {
        shell: "Contents/MacOS/collie-desktop",
        core: "Contents/MacOS/collie-core",
        icon: "Contents/Resources/Collie.icns",
        version: "Contents/Resources/version.json",
      }
    : {
        shell: "collie-desktop",
        core: "collie-core",
        icon: "collie.png",
        version: "version.json",
      };

/** Names the update files apart from Electrobun's, which the same release carries. */
const prefixOf = (os: Os, arch: string) => `rune-${CHANNEL}-${os}-${arch}`;

const run = Effect.fn("bundle.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; env?: Env } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      ...options,
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const [exitCode, stderr] = yield* Effect.all(
    [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0)
    return yield* new Cause.UnknownError(exitCode, `${command} failed: ${stderr}`);
}, Effect.scoped);

/** Desktop's main process with the stdio stand-in for Electrobun, needing no Bun to run. */
export const compileCore = (outfile: string) =>
  run(
    process.execPath,
    [
      "build",
      "--compile",
      "--tsconfig-override",
      `${ROOT}desktop-rune/core/tsconfig.json`,
      `${ROOT}desktop/src/bun/index.ts`,
      "--outfile",
      outfile,
    ],
    { cwd: `${ROOT}desktop` },
  );

const infoPlist = (version: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${pipe(
  [
    ["CFBundleName", "Collie"],
    ["CFBundleDisplayName", "Collie"],
    ["CFBundleIdentifier", IDENTIFIER],
    ["CFBundleExecutable", "collie-desktop"],
    ["CFBundleIconFile", "Collie"],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
    ["LSMinimumSystemVersion", "13.0"],
  ],
  Arr.map(([key, value]) => `<key>${key}</key><string>${value}</string>`),
  Arr.join("\n"),
)}
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;

// install-desktop.sh writes the absolute Exec and Icon when it installs the entry.
const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=Collie
Exec=collie-desktop
Icon=collie
Categories=Development;
`;

const entitlementsPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${pipe(
  Rec.keys(MAC_ENTITLEMENTS),
  Arr.map((key) => `<key>${key}</key><true/>`),
  Arr.join("\n"),
)}
</dict></plist>
`;

/** codesign's arguments for each part of the app, inside out, as Electrobun signs Desktop. */
export const macSignings = (
  env: Env,
  entitlements: string,
  app: string,
): ReadonlyArray<ReadonlyArray<string>> => {
  const identity = macSigning(env).codesign ? (env.ELECTROBUN_DEVELOPER_ID ?? "-") : "-";
  // Apple's timestamp server serves a real identity only.
  const timestamp = identity === "-" ? [] : ["--timestamp"];
  return Arr.map(
    [`${app}/Contents/MacOS/collie-core`, `${app}/Contents/MacOS/collie-desktop`, app],
    (path) => [
      "--force",
      ...timestamp,
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      "--sign",
      identity,
      path,
    ],
  );
};

/** `xcrun`'s arguments to notarise `zip`, or null where Desktop's build would not. */
export const notarizeArgs = (env: Env, zip: string): ReadonlyArray<string> | null => {
  if (!macSigning(env).notarize) return null;
  const submit = ["notarytool", "submit", zip, "--wait"];
  const appleId = Arr.every(
    [env.ELECTROBUN_APPLEID, env.ELECTROBUN_APPLEIDPASS, env.ELECTROBUN_TEAMID],
    (value) => (value ?? "") !== "",
  );
  return appleId
    ? [
        ...submit,
        "--apple-id",
        env.ELECTROBUN_APPLEID ?? "",
        "--password",
        env.ELECTROBUN_APPLEIDPASS ?? "",
        "--team-id",
        env.ELECTROBUN_TEAMID ?? "",
      ]
    : [
        ...submit,
        "--key",
        env.ELECTROBUN_APPLEAPIKEYPATH ?? "",
        "--key-id",
        env.ELECTROBUN_APPLEAPIKEY ?? "",
        "--issuer",
        env.ELECTROBUN_APPLEAPIISSUER ?? "",
      ];
};

/** Signs `app` inside out, then notarises and staples it where the secrets are set. */
const signMac = (env: Env, work: string) => (app: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entitlements = `${work}/entitlements.plist`;
    yield* fs.writeFileString(entitlements, entitlementsPlist);
    for (const args of macSignings(env, entitlements, app)) yield* run("codesign", args);
    const zip = `${work}/Collie.zip`;
    const notarize = notarizeArgs(env, zip);
    if (notarize === null) return;
    yield* run("ditto", ["-c", "-k", "--keepParent", app, zip]);
    yield* run("xcrun", notarize);
    yield* run("xcrun", ["stapler", "staple", app]);
  });

export interface AssembleOptions {
  readonly out: string;
  readonly os: Os;
  readonly arch: string;
  readonly shell: string;
  readonly core: string;
  readonly icon: string;
  readonly version: string;
  readonly baseUrl: string;
  /** Runs on the finished bundle before it is archived, as signing does. */
  readonly prepare?: (
    bundle: string,
  ) => Effect.Effect<
    void,
    PlatformError | Cause.UnknownError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >;
}

const VersionJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    channel: Schema.String,
    identifier: Schema.String,
    baseUrl: Schema.String,
    hash: Schema.String,
  }),
);
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    identifier: Schema.String,
    channel: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
    version: Schema.String,
    hash: Schema.String,
    artifact: Schema.Struct({ file: Schema.String }),
  }),
);

/**
 * Lays the bundle out under `out/build/<os>-<arch>/`, and its update archive and manifest
 * under `out/artifacts/`, as Electrobun lays Desktop's out for `tools/verify-mac-app.sh`.
 */
export const assemble = Effect.fn("bundle.assemble")(function* (options: AssembleOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { os, arch } = options;
  const name = bundleNameOf(os);
  const layout = layoutOf(os);
  const build = path.join(options.out, "build", `${os}-${arch}`);
  const bundle = path.join(build, name);
  yield* fs.remove(bundle, { recursive: true, force: true });
  const put = Effect.fn("bundle.put")(function* (inside: string, from: string, mode: number) {
    const to = path.join(bundle, inside);
    yield* fs.makeDirectory(path.dirname(to), { recursive: true });
    yield* fs.copyFile(from, to);
    yield* fs.chmod(to, mode);
  });
  yield* put(layout.shell, options.shell, 0o755);
  yield* put(layout.core, options.core, 0o755);
  yield* put(layout.icon, options.icon, 0o644);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(yield* fs.readFile(options.shell));
  hasher.update(yield* fs.readFile(options.core));
  const hash = pipe(hasher.digest("hex"), Str.slice(0, 13));
  yield* fs.writeFileString(
    path.join(bundle, layout.version),
    yield* Schema.encodeEffect(VersionJson)({
      version: options.version,
      channel: CHANNEL,
      identifier: IDENTIFIER,
      baseUrl: options.baseUrl,
      hash,
    }),
  );
  if (os === "macos")
    yield* fs.writeFileString(path.join(bundle, "Contents/Info.plist"), infoPlist(options.version));
  else yield* fs.writeFileString(path.join(bundle, "collie-desktop.desktop"), DESKTOP_ENTRY);
  if (options.prepare !== undefined) yield* options.prepare(bundle);

  const artifacts = path.join(options.out, "artifacts");
  yield* fs.makeDirectory(artifacts, { recursive: true });
  const prefix = prefixOf(os, arch);
  const file = `${prefix}-collie-desktop${os === "macos" ? ".app" : ""}.tar.zst`;
  const tar = path.join(artifacts, `${prefix}.tar`);
  yield* run("tar", ["-cf", tar, "-C", build, name]);
  yield* fs.writeFile(path.join(artifacts, file), Bun.zstdCompressSync(yield* fs.readFile(tar)));
  yield* fs.remove(tar);
  yield* fs.writeFileString(
    path.join(artifacts, `${prefix}-update.json`),
    yield* Schema.encodeEffect(Manifest)({
      identifier: IDENTIFIER,
      channel: CHANNEL,
      platform: os,
      arch,
      version: options.version,
      hash,
      artifact: { file },
    }),
  );
});

/** The macOS icon, from the brand tile as Desktop's build makes its icon set. */
const macIcon = (work: string) =>
  Effect.gen(function* () {
    yield* run(process.execPath, [`${ROOT}desktop/scripts/bun/mac-icons.ts`], {
      env: { ELECTROBUN_OS: "macos" },
    });
    yield* run("iconutil", [
      "-c",
      "icns",
      `${ROOT}desktop/mac.iconset`,
      "-o",
      `${work}/Collie.icns`,
    ]);
    return `${work}/Collie.icns`;
  });

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const os: Os = process.platform === "darwin" ? "macos" : "linux";
  const out = Bun.argv[2] ?? `${ROOT}desktop-rune/dist`;
  const work = `${out}/work`;
  yield* fs.makeDirectory(work, { recursive: true });
  yield* run("cargo", ["build", "--release", "-p", "collie-desktop-board"], {
    cwd: `${ROOT}desktop-rune`,
  });
  yield* compileCore(`${work}/collie-core`);
  const env: Env = process.env;
  yield* assemble({
    out,
    os,
    arch: process.arch,
    shell: `${ROOT}desktop-rune/target/release/collie-desktop-board`,
    core: `${work}/collie-core`,
    icon: os === "macos" ? yield* macIcon(work) : `${ROOT}assets/brand/logos/collie-tile-256.png`,
    version: manifest.version,
    baseUrl: BASE_URL,
    prepare: os === "macos" ? signMac(env, work) : undefined,
  });
  yield* fs.remove(work, { recursive: true });
  yield* Console.log(`built ${bundleNameOf(os)} under ${out}`);
});

if (import.meta.main)
  BunRuntime.runMain(
    program.pipe(
      Effect.tapCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Console.error(Cause.pretty(cause)),
      ),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
