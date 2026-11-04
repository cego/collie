import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Str from "effect/String";

test("a file that loads no .tsx loads no Babel", () =>
  expect(Arr.filter(Record.keys({ ...require.cache }), Str.includes("/@babel/"))).toEqual([]));
