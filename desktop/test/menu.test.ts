// The menu a Mac routes its key equivalents through, and no menu anywhere else.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { applicationMenu } from "../src/bun/menu";

const roles = (label: string) => {
  const menu = Option.getOrUndefined(
    Arr.findFirst(applicationMenu("darwin"), (one) => "label" in one && one.label === label),
  );
  return menu && "submenu" in menu
    ? Arr.map(menu.submenu ?? [], (item) =>
        "role" in item ? item.role : "type" in item ? item.type : undefined,
      )
    : [];
};

test("a Mac gets an app menu that hides and quits", () => {
  expect(roles("Collie")).toEqual([
    "about",
    "separator",
    "hide",
    "hideOthers",
    "showAll",
    "separator",
    "quit",
  ]);
});

test("a Mac gets an Edit menu whose roles carry cut, copy, paste and undo", () => {
  expect(roles("Edit")).toEqual([
    "undo",
    "redo",
    "separator",
    "cut",
    "copy",
    "paste",
    "pasteAndMatchStyle",
    "selectAll",
  ]);
});

test("a Mac gets a Window menu that minimizes, zooms and closes", () => {
  expect(roles("Window")).toEqual(["minimize", "zoom", "close"]);
});

test("any other platform has no menu", () => {
  for (const platform of ["linux", "win32"]) expect(applicationMenu(platform)).toEqual([]);
});
