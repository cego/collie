import { expect, test } from "bun:test";
import { agentName, launchedAs } from "../src/naming";
import { steerTarget } from "../src/steer-target";

const builder = (done: boolean) => ({
  agent: "r1-build-r1",
  operation: "02-b.md",
  role: "implementer",
  done,
});
const reviewer = (done: boolean) => ({
  agent: "r1-review-r1",
  operation: "review-1",
  role: "reviewer",
  done,
});

test("a busy builder takes the steer, not the idle reviewer launched after it", () => {
  expect(steerTarget([builder(false), reviewer(true)], {})).toMatchObject({
    agent: "r1-build-r1",
  });
});

test("with no step active, the builder takes it, even when a reviewer was launched last", () => {
  expect(steerTarget([builder(true), reviewer(true)], {})).toMatchObject({ agent: "r1-build-r1" });
});

test("an active step's agent takes it, whatever its role", () => {
  expect(steerTarget([builder(true), reviewer(false)], {})).toMatchObject({
    agent: "r1-review-r1",
  });
});

test("only an agent's newest launch says whether it is at work", () => {
  const earlier = { ...builder(false), operation: "01-a.md" };
  expect(steerTarget([earlier, builder(true), reviewer(true)], {})).toMatchObject({
    operation: "02-b.md",
  });
});

test("a Run with no builder falls back to the agent launched last", () => {
  const planner = { agent: "r1-grill-r1", operation: "plan", role: "planner", done: true };
  expect(steerTarget([planner, reviewer(true)], {})).toMatchObject({ agent: "r1-review-r1" });
});

test("--to names a role, an agent or an operation", () => {
  const both = [builder(false), reviewer(true)];
  expect(steerTarget(both, { to: "reviewer" })).toMatchObject({ agent: "r1-review-r1" });
  expect(steerTarget(both, { to: "builder" })).toMatchObject({ agent: "r1-build-r1" });
  expect(steerTarget(both, { to: "r1-review-r1" })).toMatchObject({ agent: "r1-review-r1" });
  expect(steerTarget(both, { to: "review-1" })).toMatchObject({ agent: "r1-review-r1" });
  expect(steerTarget(both, { to: "planner" })).toBeUndefined();
});

test("--operation and an agent's name behave as before", () => {
  const both = [builder(false), reviewer(true)];
  expect(steerTarget(both, { operation: "review-1" })).toMatchObject({ agent: "r1-review-r1" });
  expect(steerTarget(both, { operation: "r1-review-r1" })).toMatchObject({
    agent: "r1-review-r1",
  });
  expect(steerTarget(both, { agent: "r1-review-r1", operation: "02-b.md" })).toMatchObject({
    agent: "r1-review-r1",
  });
  expect(steerTarget([], {})).toBeUndefined();
});

test("an agent is found by the name it was launched under, though its operations are tickets", () => {
  const runId = "run-20058fd6.implement";
  const agent = agentName(runId, "build", null, 1);
  const tickets = [
    { agent, operation: "01-a.md", role: "implementer", done: true, runId, sequence: 1 },
    { agent, operation: "02-b.md", role: "implementer", done: true, runId, sequence: 1 },
  ];
  for (const asked of [{ agent: "build" }, { operation: "build" }, { to: "build" }])
    expect(steerTarget(tickets, asked, launchedAs)).toMatchObject({ operation: "02-b.md" });
  expect(steerTarget(tickets, { agent: "review" }, launchedAs)).toBeUndefined();
});
