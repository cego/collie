// What a human actually reads before they say yes.
//
// `describeAction` is the whole payload: the board draws these lines under the
// interpretation, and chat's own reply repeats them. The interpretation above them is a
// model's prose, and a yes is a yes to the payload rather than to a summary of it — so a
// field that decides what a change does, or where it lands, has to be in the line rather
// than only in the JSON.

import { expect, test } from "bun:test";
import { describeAction } from "../src/lines";

test("an action that names a workspace says which one", () => {
  // Both of these write outside any Run: the defaults a workspace's next Runs begin with,
  // and the checkout a launch roots in. Which workspace is the field that decides what
  // the change does, and it was absent from what the human read.
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
  // The inputs are what the Run actually does; a yes to a workflow name alone is a yes to
  // a plan the human never read.
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
  // It roots wherever the confirmation is carried out, which from the board is the Home
  // and nobody's repository. Silence there reads as "the obvious one".
  const said = describeAction({ kind: "start", workflow: "implement", inputs: {} });
  expect(said).toBe("start implement in no workspace named — wherever this is confirmed");
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
