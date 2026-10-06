// Opening a web page in the human's default browser, in a window of its own where it can.

import { expect, test } from "bun:test";
import { appWindow } from "../src/bun/browser";

const URL_ = "https://claude.ai/artifact/1";

const entry = (exec: string, action = "") =>
  `[Desktop Entry]\nName=Browser\nExec=${exec}\nType=Application\n${action}`;

test("a Chromium-based browser is started with the page as an app", () => {
  for (const id of [
    "google-chrome.desktop",
    "chromium-browser.desktop",
    "com.brave.Browser.desktop",
    "microsoft-edge.desktop",
    "vivaldi-stable.desktop",
  ])
    expect(appWindow(id, entry("/usr/bin/browser %U"), URL_)).toEqual([
      "/usr/bin/browser",
      `--app=${URL_}`,
    ]);
});

test("any other browser is left to open its ordinary tab", () => {
  for (const id of ["firefox.desktop", "knowledge-browser.desktop"])
    expect(appWindow(id, entry("firefox %u"), URL_)).toBeNull();
});

test("the entry's own command is kept, quoted arguments and all, with its field codes gone", () => {
  expect(
    appWindow(
      "com.brave.Browser.desktop",
      entry('/usr/bin/flatpak run --command=brave "--branch=stable" com.brave.Browser @@u %U @@'),
      URL_,
    ),
  ).toEqual([
    "/usr/bin/flatpak",
    "run",
    "--command=brave",
    "--branch=stable",
    "com.brave.Browser",
    `--app=${URL_}`,
  ]);
});

test("the command is the entry's, not one of its actions'", () => {
  expect(
    appWindow(
      "google-chrome.desktop",
      `[Desktop Action new-window]\nExec=/opt/chrome --new-window\n\n${entry("/opt/chrome/chrome %U")}`,
      URL_,
    ),
  ).toEqual(["/opt/chrome/chrome", `--app=${URL_}`]);
});

test("an entry with no command opens an ordinary tab", () => {
  expect(appWindow("google-chrome.desktop", "[Desktop Entry]\nName=Chrome\n", URL_)).toBeNull();
});

test("spaces around an entry's equals sign are allowed", () => {
  expect(appWindow("chromium.desktop", "[Desktop Entry]\nExec = chromium %U\n", URL_)).toEqual([
    "chromium",
    `--app=${URL_}`,
  ]);
});
