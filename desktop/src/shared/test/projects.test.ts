import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import type { FlockItem } from "../flock";
import { EMPTY_FLOCK, FlockItem as FlockItemSchema, applyItem } from "../flock";
const asItem = (value: Schema.Json) =>
  Result.getOrThrow(Schema.decodeUnknownResult(FlockItemSchema)(value));
const machine: Schema.Json = { installation: "i-pc", profile: "local", name: "mk-pc" };
const project = (id: string, name: string) => ({
  // WARNING: the schema decodes it, so a JSON value here is all it takes.

  installation: "i-pc",
  id,
  name,
  starred: false,
  archived: false,
  tasks: 0,
  needs: 0,
});
const snapshot = (projects: ReadonlyArray<Schema.Json>) => {
  const returned: FlockItem = asItem({
    machine,
    message: {
      _tag: "Snapshot",
      installation: "i-pc",
      build: "1.0.34",
      protocol: 5,
      herds: [],
      projects,
      tasks: [],
      seq: 1,
    },
  });
  return returned;
};
const changed = (projects: ReadonlyArray<Schema.Json>) => {
  const returned: FlockItem = asItem({
    machine,
    message: { _tag: "Projects", projects, seq: 2 },
  });
  return returned;
};
const names = (item: FlockItem) =>
  Arr.map(applyItem(EMPTY_FLOCK, item).machines.get("i-pc")?.projects ?? [], (one) => one.name);
test("a Machine's board carries its Projects, and a Projects message replaces them whole", () => {
  const first = applyItem(EMPTY_FLOCK, snapshot([project("project-a", "Payments")]));
  expect(Arr.map(first.machines.get("i-pc")?.projects ?? [], (one) => one.name)).toEqual([
    "Payments",
  ]);
  const second = applyItem(
    first,
    changed([project("project-a", "Payments"), project("project-b", "CEGO Platform")]),
  );
  expect(Arr.map(second.machines.get("i-pc")?.projects ?? [], (one) => one.name)).toEqual([
    "Payments",
    "CEGO Platform",
  ]);
  // WARNING: a Project put away leaves the list; a board that merged would keep it here.
  const third = applyItem(second, changed([project("project-b", "CEGO Platform")]));
  expect(Arr.map(third.machines.get("i-pc")?.projects ?? [], (one) => one.id)).toEqual([
    "project-b",
  ]);
});
test("a board from before Projects keeps its Tasks and says it has none", () => {
  expect(names(snapshot([]))).toEqual([]);
});
