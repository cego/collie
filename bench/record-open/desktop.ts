// Desktop as the benchmark runs it: the tree's own view, generated with the WebSocket
// transport, served by Desktop's own main process, and drawn by a Chrome on this Machine.

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { root, world } from "./world";

const bench = `${root}bench/record-open`;
export const viewDir = `${bench}/view/.output/public`;

const run = (argv: ReadonlyArray<string>, cwd: string) => {
  const ran = Bun.spawnSync([...argv], { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (ran.exitCode !== 0) throw new Error(`${argv.join(" ")} in ${cwd} exited ${ran.exitCode}`);
};

/** Installs Desktop's packages where a fresh checkout lacks them, then generates the view. */
export const buildView = () => {
  if (!existsSync(`${root}desktop/node_modules`))
    run(["bun", "install", "--frozen-lockfile"], `${root}desktop`);
  if (!existsSync(`${bench}/view/node_modules`))
    symlinkSync("../../../desktop/node_modules", `${bench}/view/node_modules`);
  // Desktop's view reads the tsconfig its own prepare writes.
  run(["bunx", "nuxi", "prepare", "view"], `${root}desktop`);
  run(["bunx", "nuxi", "generate"], `${bench}/view`);
};

export const VIEW_PORT = 47311;

/** Desktop's main process, with the benchmark's Electrobun, serving the view on loopback. */
export const startDesktop = () =>
  Bun.spawn(
    [
      process.execPath,
      "--tsconfig-override",
      `${bench}/desktop-tsconfig.json`,
      `${root}desktop/src/bun/index.ts`,
    ],
    {
      cwd: `${root}desktop`,
      env: {
        ...Bun.env,
        XDG_STATE_HOME: `${world.desktop}/state`,
        BENCH_USER_DATA: `${world.desktop}/data`,
        BENCH_VIEW_DIR: viewDir,
        BENCH_VIEW_PORT: String(VIEW_PORT),
        COLLIE_DESKTOP_COLLIE: JSON.stringify([process.execPath, `${root}src/main.ts`]),
      },
      stdio: ["ignore", Bun.file(`${world.desktop}.out`), Bun.file(`${world.desktop}.err`)],
    },
  );

export const viewUp = async () => {
  for (let tries = 0; tries < 300; tries++) {
    const answered = await fetch(`http://127.0.0.1:${VIEW_PORT}/`).catch(() => null);
    if (answered?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("Desktop's view did not come up");
};

export const WINDOW = { width: 1600, height: 1000 };

/** Chrome for Testing as Puppeteer or Playwright installed it, newest first. */
const installedChrome = () => {
  const candidates = [
    ...readdirIn(`${homedir()}/.cache/puppeteer/chrome`).map(
      (version) => `${homedir()}/.cache/puppeteer/chrome/${version}/chrome-linux64/chrome`,
    ),
    ...readdirIn(`${homedir()}/.cache/ms-playwright`)
      .filter((name) => name.startsWith("chromium-"))
      .map((name) => `${homedir()}/.cache/ms-playwright/${name}/chrome-linux64/chrome`),
  ];
  return candidates
    .filter((path) => existsSync(path))
    .sort()
    .reverse()[0];
};
const readdirIn = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

export interface Chrome {
  readonly cdp: string;
  readonly binary: string | null;
  readonly flags: ReadonlyArray<string>;
  readonly stop: () => void;
}

/**
 * A headless Chrome of the benchmark's own, on a loopback port, with a profile that is
 * removed when it stops. Without the sandbox: Ubuntu's AppArmor refuses Chrome's user
 * namespaces, and the page it loads is the benchmark's own view.
 */
export const launchChrome = async (binary = installedChrome()): Promise<Chrome> => {
  if (binary === undefined)
    throw new Error("no Chrome found; pass --chrome <binary> or --cdp <endpoint>");
  const profile = `${world.desktop}/chrome-profile`;
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const flags = [
    "--headless=new",
    "--no-sandbox",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const chrome = Bun.spawn([binary, ...flags, `--user-data-dir=${profile}`, "about:blank"], {
    stdio: ["ignore", "ignore", Bun.file(`${world.desktop}.chrome.err`)],
  });
  const portFile = `${profile}/DevToolsActivePort`;
  let port = "";
  for (let tries = 0; tries < 300 && port === ""; tries++) {
    await Bun.sleep(100);
    port =
      (
        await Bun.file(portFile)
          .text()
          .catch(() => "")
      ).split("\n")[0] ?? "";
  }
  if (port === "")
    throw new Error(`Chrome wrote no DevTools port; see ${world.desktop}.chrome.err`);
  return {
    cdp: `http://127.0.0.1:${port}`,
    binary,
    flags,
    stop: () => {
      chrome.kill();
      rmSync(profile, { recursive: true, force: true });
    },
  };
};
