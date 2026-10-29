import { expect, test } from "bun:test";

test("a file that loads no .tsx loads no Babel", () =>
  expect(Object.keys(require.cache).filter((path) => path.includes("/@babel/"))).toEqual([]));
