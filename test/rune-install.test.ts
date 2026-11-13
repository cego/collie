import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { assemble, packageInstaller } from "../desktop-rune/scripts/bundle";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const installation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-cutover-" });
  const home = `${dir}/home with spaces`;
  const data = `${home}/data`;
  const root = `${data}/dk.cego.collie.desktop/stable`;
  yield* fs.makeDirectory(`${root}/app/bin`, { recursive: true });
  yield* fs.writeFileString(`${root}/app/bin/launcher`, "old app");
  yield* fs.makeDirectory(`${root}/app/Resources/views`, { recursive: true });
  yield* fs.writeFileString(`${root}/app/Resources/views/old.html`, "old webview");
  yield* fs.makeDirectory(`${data}/applications`, { recursive: true });
  yield* fs.writeFileString(`${data}/applications/collie-desktop.desktop`, "old entry");
  yield* fs.writeFileString(`${root}/settings.json`, "settings and connections");
  yield* fs.writeFileString(`${dir}/shell`, "#!/bin/sh\necho native Collie\n");
  yield* fs.writeFileString(`${dir}/core`, "#!/bin/sh\nexit 0\n");
  yield* fs.writeFileString(`${dir}/manager`, "legacy manager");
  yield* fs.writeFileString(`${dir}/icon`, "icon");
  const out = `${dir}/dist`;
  yield* assemble({
    out,
    os: "linux",
    arch: "x64",
    shell: `${dir}/shell`,
    core: `${dir}/core`,
    manager: `${dir}/manager`,
    icon: `${dir}/icon`,
    version: "0.133.0",
    baseUrl: "https://example.invalid",
  });
  yield* packageInstaller(out, "linux", "x64");
  const extracted = `${dir}/setup`;
  yield* fs.makeDirectory(extracted);
  yield* exec([
    "tar",
    "-xzf",
    `${out}/artifacts/linux-x64-collie-desktop-Setup.tar.gz`,
    "-C",
    extracted,
  ]);
  return { dir, home, data, root, extracted };
});

test("the native installer replaces the old app and entry while keeping settings and connections", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, data, root, extracted } = yield* installation;
      const installed = yield* exec(["sh", `${extracted}/installer`], {
        env: { PATH: Bun.env.PATH!, HOME: home, XDG_DATA_HOME: data },
      });
      expect(installed.exitCode).toBe(0);
      expect(yield* fs.readFileString(`${root}/settings.json`)).toBe("settings and connections");
      expect(yield* fs.exists(`${root}/app/Resources/views`)).toBe(false);
      const launched = yield* exec([`${root}/app/bin/launcher`]);
      expect(launched.stdout).toBe("native Collie\n");
      expect(yield* fs.readDirectory(`${data}/applications`)).toEqual(["collie-desktop.desktop"]);
      const entry = yield* fs.readFileString(`${data}/applications/collie-desktop.desktop`);
      expect(entry).toContain("Name=Collie\n");
      expect(entry).toContain("StartupWMClass=collie-desktop\n");
      expect(entry).toContain(`Exec="${root}/app/bin/launcher"`);
    }),
  ));

test("an interrupted copy leaves the old app and its launcher entry intact", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, home, data, root, extracted } = yield* installation;
      yield* fs.makeDirectory(`${dir}/bin`);
      yield* fs.writeFileString(`${dir}/bin/cp`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const installed = yield* exec(["sh", `${extracted}/installer`], {
        env: { PATH: `${dir}/bin:${Bun.env.PATH}`, HOME: home, XDG_DATA_HOME: data },
      });
      expect(installed.exitCode).not.toBe(0);
      expect(yield* fs.readFileString(`${root}/app/bin/launcher`)).toBe("old app");
      expect(yield* fs.readFileString(`${data}/applications/collie-desktop.desktop`)).toBe(
        "old entry",
      );
      expect(Arr.sort(yield* fs.readDirectory(root), Str.Order)).toEqual(["app", "settings.json"]);
    }),
  ));
