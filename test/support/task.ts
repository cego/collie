import * as Arr from "effect/Array";
import * as Str from "effect/String";
import type { TaskMr, TaskView } from "../../src/board-model";
import { epochMs } from "../../src/time";

export function task(over: Partial<TaskView> = {}) {
  const returned: TaskView = {
    id: "t1",
    name: "Strapi prod seeder",
    project: "content",
    state: "active",
    steps: [
      { name: "build", state: "done" },
      { name: "review", state: "active" },
      { name: "mr", state: "todo" },
    ],
    sentence: "Fixing the review findings, round 2 of 5.",
    age: "58m",
    drift: null,
    held: null,
    heldBy: null,
    decision: null,
    agents: [],
    children: [],
    mr: null,
    branch: "mk/strapi-seed",
    disposition: null,
    landed: (over.state ?? "active") === "done",
    ended: null,
    mrState: null,
    checks: null,
    ready: false,
    check: null,
    reopened: null,
    planReady: false,
    offer: null,
    run: "r1",
    runs: ["r1"],
    at: epochMs("2026-09-16T12:00:00.000Z"),
    ...over,
  };
  return returned;
}

export function taskMr(project: string, iid: number, over: Partial<TaskMr> = {}) {
  const url = `https://gitlab.cego.dk/${project}/-/merge_requests/${iid}`;
  const short = `${Arr.lastNonEmpty(Str.split(project, "/"))}!${iid}`;
  const returned: TaskMr = {
    id: `gitlab.cego.dk/${project}!${iid}`,
    mr: url,
    label: `${project}!${iid}`,
    short,
    url,
    run: "r1",
    state: "open",
    checks: null,
    head: null,
    ready: false,
    disposition: null,
    waitsOn: [],
    ...over,
  };
  return returned;
}
