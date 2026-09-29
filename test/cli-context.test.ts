import { expect, test } from "bun:test";
import { contextCwd } from "../src/commands/shared";

test("a workspace inherited from the pane never outranks the directory the caller is in", () => {
  const at = { explicit: "", workspace: "/state/herd/home", caller: "/src/monorepo" };
  expect(contextCwd({ ...at, named: false })).toBe("/src/monorepo");
  // Named with --workspace, the workspace's directory is what was asked for.
  expect(contextCwd({ ...at, named: true })).toBe("/state/herd/home");
  expect(contextCwd({ ...at, named: true, explicit: "/given" })).toBe("/given");
  expect(contextCwd({ ...at, named: true, workspace: "" })).toBe("/src/monorepo");
});
