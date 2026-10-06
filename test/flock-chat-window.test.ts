// What the Flock chat's window says of a tool call and of the card a message is about.

import { expect, test } from "bun:test";
import { aboutLine, toolRow } from "../desktop/src/shared/chat-view";

test("a tool call is its tool, the Machine it reached and what it was asked", () => {
  expect(
    toolRow(
      "mcp__collie__collie_do",
      JSON.stringify({
        actions: [
          { kind: "stop", run: "vm-mk:r-2" },
          { kind: "hold", run: "vm-mk:r-3", reason: "lunch" },
        ],
      }),
    ),
  ).toEqual({ tool: "do", machine: "vm-mk", summary: "stop r-2, hold r-3" });
  expect(
    toolRow("mcp__collie__collie_hold", JSON.stringify({ run: "mk-pc:r-1", reason: "lunch" })),
  ).toEqual({
    tool: "hold",
    machine: "mk-pc",
    summary: "r-1 · lunch",
  });
});

test("a call that names no Machine, or several, says so", () => {
  expect(toolRow("mcp__collie__collie_herd", "{}")).toEqual({
    tool: "herd",
    machine: null,
    summary: "",
  });
  expect(
    toolRow(
      "mcp__collie__collie_do",
      JSON.stringify({
        actions: [
          { kind: "stop", run: "a:r-1" },
          { kind: "stop", run: "b:r-1" },
        ],
      }),
    ).machine,
  ).toBe("a, b");
});

test("arguments still streaming are summarised as far as they go", () => {
  expect(toolRow("mcp__collie__collie_run", '{"run": "vm-')).toEqual({
    tool: "run",
    machine: null,
    summary: "",
  });
});

test("a card a message is about reads as its Machine and its name", () => {
  expect(
    aboutLine({
      machine: "vm-mk",
      task: "t-1",
      run: "r-2",
      name: "Fix board bugs",
    }),
  ).toBe("vm-mk › Fix board bugs");
});
