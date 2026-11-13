// Builds Collie for this computer, with the stable update archive, manifest and installer (desktop/README.md):
//
//   bun run desktop/scripts/bundle.ts [out]   # out defaults to desktop/dist
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
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { MAC_ENTITLEMENTS, macSigning } from "./mac-signing";
import { appliedSignatureOf, RELEASE_PUBLIC_KEY, verifyRelease } from "../../src/signing";
import manifest from "../../herdr-plugin.toml";

export type Os = "linux" | "macos";
type Env = Record<string, string | undefined>;

const ROOT = new URL("../../", import.meta.url).pathname;
const IDENTIFIER = "dk.cego.collie.desktop";
const CHANNEL = "stable";
const BASE_URL = "https://github.com/cego/collie/releases/latest/download";

export const bundleNameOf = (os: Os) => (os === "macos" ? "collie-desktop.app" : "collie-desktop");

/** Where each part sits inside the bundle. */
const layoutOf = (os: Os) =>
  os === "macos"
    ? {
        shell: "Contents/MacOS/launcher",
        core: "Contents/MacOS/collie-core",
        icon: "Contents/Resources/Collie.icns",
        version: "Contents/Resources/version.json",
      }
    : {
        shell: "bin/launcher",
        core: "bin/collie-core",
        icon: "Resources/appIcon.png",
        version: "Resources/version.json",
      };

/** Preserve the update filenames already installed apps request. */
const prefixOf = (os: Os, arch: string) => `${CHANNEL}-${os}-${arch}`;

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

/** Desktop's native core, compiled so it needs no installed Bun. */
export const compileCore = (outfile: string) =>
  run(
    process.execPath,
    [
      "build",
      "--compile",
      "--tsconfig-override",
      `${ROOT}desktop/core/tsconfig.json`,
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
    ["CFBundleExecutable", "launcher"],
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
StartupWMClass=collie-desktop
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

/** codesign's arguments for each part of the app, inside out. */
export const macSignings = (
  env: Env,
  entitlements: string,
  app: string,
): ReadonlyArray<ReadonlyArray<string>> => {
  const identity = macSigning(env).codesign ? (env.ELECTROBUN_DEVELOPER_ID ?? "-") : "-";
  // Apple's timestamp server serves a real identity only.
  const timestamp = identity === "-" ? [] : ["--timestamp"];
  return Arr.map(
    [`${app}/Contents/MacOS/collie-core`, `${app}/Contents/MacOS/launcher`, app],
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
  /** Retained only for the old updater's bundle validation and uninstall contract. */
  readonly manager: string;
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
    name: Schema.String,
    displayName: Schema.String,
    version: Schema.String,
    channel: Schema.String,
    identifier: Schema.String,
    baseUrl: Schema.String,
    hash: Schema.String,
  }),
);
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
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
  yield* put(`${os === "macos" ? "Contents/" : ""}Resources/uninstall`, options.manager, 0o755);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(yield* fs.readFile(options.shell));
  hasher.update(yield* fs.readFile(options.core));
  const hash = pipe(hasher.digest("hex"), Str.slice(0, 13));
  yield* fs.writeFileString(
    path.join(bundle, layout.version),
    yield* Schema.encodeEffect(VersionJson)({
      name: "collie-desktop",
      displayName: "Collie",
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
  yield* run("tar", ["--format=ustar", "-cf", tar, "-C", build, name]);
  yield* fs.writeFile(path.join(artifacts, file), Bun.zstdCompressSync(yield* fs.readFile(tar)));
  yield* fs.remove(tar);
  yield* fs.writeFileString(
    path.join(artifacts, `${prefix}-update.json`),
    yield* Schema.encodeEffect(Manifest)({
      schemaVersion: 1,
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

/** The installed v2 updater requires its native manager in every replacement bundle. */
const compatibilityManager = (os: Os, arch: string, work: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const archive = `stable-${os}-${arch}-collie-desktop${os === "macos" ? ".app" : ""}.tar.zst`;
    const base = "https://github.com/cego/collie/releases/download/0.132.2";
    const bytes = (file: string) =>
      HttpClient.get(`${base}/${file}`).pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status !== 200)
              return yield* new Cause.UnknownError(response.status, `could not download ${file}`);
            return yield* response.arrayBuffer;
          }),
        ),
        Effect.map((body) => new Uint8Array(body)),
      );
    const tar = Bun.zstdDecompressSync(yield* bytes(archive));
    const signatureName = appliedSignatureOf(archive);
    if (signatureName === null)
      return yield* new Cause.UnknownError(null, "the compatibility archive has no signature name");
    const signature = new TextDecoder().decode(yield* bytes(signatureName));
    const checked = verifyRelease(tar, signature, RELEASE_PUBLIC_KEY);
    if (!checked.ok) return yield* new Cause.UnknownError(null, checked.reason);
    const source = `${work}/compatibility`;
    yield* fs.makeDirectory(source, { recursive: true });
    yield* fs.writeFile(`${source}/bundle.tar`, tar);
    const member = `collie-desktop${os === "macos" ? ".app/Contents" : ""}/Resources/uninstall`;
    yield* run("tar", ["-xf", `${source}/bundle.tar`, "-C", source, member]);
    return `${source}/${member}`;
  }).pipe(Effect.provide(FetchHttpClient.layer));

/** Keep the existing one-line installer's signed asset names. */
export const packageInstaller = (out: string, os: Os, arch: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const build = `${out}/build/${os}-${arch}`;
    if (os === "macos") {
      yield* run("hdiutil", [
        "create",
        "-volname",
        "Collie",
        "-srcfolder",
        `${build}/${bundleNameOf(os)}`,
        "-ov",
        "-format",
        "UDZO",
        `${out}/artifacts/${os}-${arch}-collie-desktop.dmg`,
      ]);
    } else {
      yield* fs.copyFile(`${ROOT}desktop/scripts/install-linux.sh`, `${build}/installer`);
      yield* fs.chmod(`${build}/installer`, 0o755);
      yield* run("tar", [
        "--format=ustar",
        "-czf",
        `${out}/artifacts/${os}-${arch}-collie-desktop-Setup.tar.gz`,
        "-C",
        build,
        "./installer",
        "./collie-desktop",
      ]);
    }
  });

/** The macOS icon, from the brand tile. */
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
  const out = Bun.argv[2] ?? `${ROOT}desktop/dist`;
  const work = `${out}/work`;
  yield* fs.makeDirectory(work, { recursive: true });
  yield* run("cargo", ["build", "--release", "-p", "collie-desktop-board"], {
    cwd: `${ROOT}desktop`,
  });
  yield* compileCore(`${work}/collie-core`);
  const env: Env = process.env;
  yield* assemble({
    out,
    os,
    arch: process.arch,
    shell: `${ROOT}desktop/target/release/collie-desktop-board`,
    core: `${work}/collie-core`,
    icon: os === "macos" ? yield* macIcon(work) : `${ROOT}assets/brand/logos/collie-tile-256.png`,
    manager: yield* compatibilityManager(os, process.arch, work),
    version: manifest.version,
    baseUrl: BASE_URL,
    prepare: os === "macos" ? signMac(env, work) : undefined,
  });
  yield* packageInstaller(out, os, process.arch);
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
