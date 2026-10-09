// Electrobun's launcher sets LD_PRELOAD and the rest for Desktop alone; what Desktop starts
// gets the user's environment instead, or every child writes ld.so errors.

import { expect, test } from "bun:test";
import { withoutLauncher } from "../desktop/src/bun/login-env";

const BIN = "/home/mk/.local/share/collie-desktop/app/bin";

/** What mk-laptop's Desktop was started with, as `/proc/<pid>/environ` showed it. */
const LAUNCHED = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/mk",
  GTK_MODULES: "gail:atk-bridge",
  LD_PRELOAD: "./libcef.so:./libvk_swiftshader.so",
  LD_LIBRARY_PATH: `${BIN}:${BIN}:${BIN}`,
  ICU_DATA: BIN,
  ELECTROBUN_LAUNCHER_PID: "4242",
  ELECTROBUN_INSTALL_ROOT_NAME: "collie-desktop",
};

test("what the launcher set for Desktop alone is left out, and nothing else", () => {
  expect(withoutLauncher(LAUNCHED, BIN)).toEqual({
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/mk",
    GTK_MODULES: "gail:atk-bridge",
  });
});

test("the user's empty library path entries are kept", () => {
  expect(withoutLauncher({ LD_LIBRARY_PATH: `${BIN}::/opt/lib:${BIN}:` }, BIN)).toEqual({
    LD_LIBRARY_PATH: ":/opt/lib:",
  });
});

test("empty launcher values are left unset", () => {
  expect(withoutLauncher({ LD_PRELOAD: "", LD_LIBRARY_PATH: "", ICU_DATA: "" }, BIN)).toEqual({});
});

test("the user's own library path and preload come back exactly, in their order", () => {
  expect(
    withoutLauncher(
      {
        ...LAUNCHED,
        LD_PRELOAD: "./libcef.so:/usr/lib/libmine.so:./libvk_swiftshader.so",
        LD_LIBRARY_PATH: `${BIN}:/opt/lib:${BIN}:/usr/local/lib`,
        ICU_DATA: "/usr/share/icu",
      },
      BIN,
    ),
  ).toEqual({
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/mk",
    GTK_MODULES: "gail:atk-bridge",
    LD_PRELOAD: "/usr/lib/libmine.so",
    LD_LIBRARY_PATH: "/opt/lib:/usr/local/lib",
    ICU_DATA: "/usr/share/icu",
  });
});
