import { Cause, Effect, FileSystem, Path } from "effect";
import { shell } from "../../src/mr";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

export const MEDIA_PLUGINS = [
  "coreelements",
  "playback",
  "typefindfunctions",
  "isomp4",
  "videoconvertscale",
  "audioconvert",
  "audioresample",
  "volume",
  "autodetect",
  "pulseaudio",
  "alsa",
  "libav",
] as const;

export const mediaDependencies = (stdout: string): ReadonlyArray<string> => {
  if (/=>\s+not found/.test(stdout))
    throw new Error("The Linux media runtime has unresolved libraries");
  const found = Arr.map(
    [...Str.matchAll(/(?:=>\s+|^\s*)(\/[^\s(]+)/gm)(stdout)],
    (match) => match[1]!,
  );
  return Arr.filter(
    [...new Set(found)],
    (file) => !/\/(?:ld-linux[^/]*|lib(?:c|m|pthread|dl|rt)\.so\.[^/]*)$/.test(file),
  );
};

export const bundleLinuxMedia = Effect.fn("bundle.linuxMedia")(function* (
  bundle: string,
  libDir: string,
  scanner: string,
  run: typeof shell = shell,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plugins = Arr.map(MEDIA_PLUGINS, (name) => `${libDir}/gstreamer-1.0/libgst${name}.so`);
  const dest = `${bundle}/lib`;
  yield* fs.makeDirectory(`${dest}/gstreamer-1.0`, { recursive: true });
  yield* fs.makeDirectory(`${bundle}/libexec`, { recursive: true });
  const libraries = new Set<string>();
  for (const file of [`${bundle}/bin/launcher`, scanner, ...plugins]) {
    const found = yield* run("ldd", [file], bundle);
    if (found.code !== 0)
      return yield* new Cause.UnknownError(
        null,
        `Could not resolve Linux media dependencies of ${file}: ${found.stderr}`,
      );
    for (const library of mediaDependencies(found.stdout)) libraries.add(library);
  }
  for (const file of libraries) yield* fs.copyFile(file, `${dest}/${path.basename(file)}`);
  for (const file of plugins)
    yield* fs.copyFile(file, `${dest}/gstreamer-1.0/${path.basename(file)}`);
  yield* fs.copyFile(scanner, `${bundle}/libexec/gst-plugin-scanner.bin`);
  yield* fs.chmod(`${bundle}/libexec/gst-plugin-scanner.bin`, 0o755);
  yield* fs.writeFileString(
    `${bundle}/libexec/gst-plugin-scanner`,
    Arr.join(
      [
        "#!/bin/sh",
        'media_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1',
        'LD_LIBRARY_PATH="$media_root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$media_root/libexec/gst-plugin-scanner.bin" "$@"',
        "",
      ],
      "\n",
    ),
  );
  yield* fs.chmod(`${bundle}/libexec/gst-plugin-scanner`, 0o755);
  const packages = new Set<string>();
  for (const file of [...libraries, scanner, ...plugins]) {
    const owner = yield* run("dpkg-query", ["--search", yield* fs.realPath(file)], bundle);
    if (owner.code !== 0)
      return yield* new Cause.UnknownError(null, `No distribution copyright record for ${file}`);
    for (const line of Str.split(Str.trim(owner.stdout), "\n"))
      packages.add(Str.split(Str.split(line, ": ")[0]!, ":")[0]!);
  }
  yield* fs.makeDirectory(`${bundle}/Resources/media-licenses`, { recursive: true });
  for (const name of packages)
    yield* fs.copyFile(
      `/usr/share/doc/${name}/copyright`,
      `${bundle}/Resources/media-licenses/${name}`,
    );
});
