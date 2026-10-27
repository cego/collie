import { expect, test } from "bun:test";
import { scenarioNames, SHARES, split } from "./support/baseline";

test("every baseline scenario is in exactly one share, and a pass's shares are all of them", () => {
  const names = scenarioNames();
  const shares = split(names, SHARES);
  expect(shares).toHaveLength(SHARES);
  expect(shares.flat().toSorted()).toEqual(names.toSorted());
});

test("a scenario added under a new name moves no other between shares", () => {
  const names = scenarioNames();
  const added = "a scenario nobody has written yet";
  const before = split(names, SHARES);
  const after = split([added, ...names], SHARES);
  expect(after.flat()).toContain(added);
  expect(after.map((share) => share.filter((name) => name !== added))).toEqual(before);
});
