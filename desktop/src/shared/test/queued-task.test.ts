import { expect, test } from "bun:test";
import { queueRefusal, queueUnsupported } from "../flock";

const refusal =
  'invalid_input: actions[0] has kind "create_task", which is not a kind Collie takes';

test("a host too old to queue a Task is told apart from a request it refused", () => {
  expect(queueRefusal(refusal)).toBe(true);
  expect(queueRefusal('invalid_input: no Task "task-1"')).toBe(false);
  expect(queueRefusal('invalid_input: actions[0] has kind "start" is missing workflow')).toBe(
    false,
  );
  const said = queueUnsupported("mk-pc");
  expect(said).toContain("cannot queue a Task");
  expect(said).toContain("mk-pc");
});
