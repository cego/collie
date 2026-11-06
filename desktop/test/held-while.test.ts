import { expect, test } from "bun:test";
import { ref } from "vue";
import { useHeldWhile } from "../view/app/composables/useHeldWhile";

test("a board held while a record covers it derives nothing from board items, and shows the latest once uncovered", () => {
  const items = ref(0);
  const covered = ref(false);
  let derived = 0;
  const board = useHeldWhile(
    () => {
      derived++;
      return { tasks: items.value };
    },
    () => covered.value,
  );
  expect(board.value.tasks).toBe(0);
  covered.value = true;
  const held = board.value;
  for (let item = 1; item <= 20; item++) {
    items.value = item;
    expect(board.value).toBe(held);
  }
  expect(derived).toBe(1);
  covered.value = false;
  expect(board.value.tasks).toBe(20);
  expect(derived).toBe(2);
});
