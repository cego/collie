import { expect, test } from "bun:test";
import { describeAction } from "../src/lines";

test("an action that names a workspace says which one", () => {
  expect(
    describeAction({
      kind: "update_defaults",
      change: "add-constraint",
      workspace: "w1",
      text: "no force pushes",
    }),
  ).toContain("w1");
  expect(
    describeAction({
      kind: "start",
      workflow: "implement",
      inputs: { plan: "a picker" },
      workspace: "w1",
    }),
  ).toBe("start implement in workspace w1 on plan=a picker");
});

test("a launch says what it would run on, not only where", () => {
  expect(
    describeAction({
      kind: "start",
      workflow: "implement",
      inputs: { plan: "plan/SPEC.md" },
      decisions: { approach: "in slices" },
      workspace: "w1",
    }),
  ).toBe(
    "start implement in workspace w1 on plan=plan/SPEC.md with approach=in slices already decided",
  );
});

test("a launch that names no workspace says so, rather than reading as though it did", () => {
  const said = describeAction({ kind: "start", workflow: "implement", inputs: {} });
  expect(said).toBe("start implement in no workspace named, so it will be refused");
});

test("a removal says the text is an id, because prose there removes nothing", () => {
  expect(
    describeAction({
      kind: "update_defaults",
      change: "remove-constraint",
      workspace: "w1",
      text: "3f2a91bc",
    }),
  ).toBe("remove the constraint 3f2a91bc from what every new Run in workspace w1 begins with");
});

test("a launch that carries its own checks says what Collie will run for them", () => {
  expect(
    describeAction({
      kind: "start",
      workflow: "implement",
      inputs: {},
      workspace: "w1",
      verify: [{ name: "unit", executable: "bun", argv: ["test"], cwd: "worktree" }],
    }),
  ).toBe("start implement in workspace w1 letting Collie run unit: bun test (in worktree)");
});
