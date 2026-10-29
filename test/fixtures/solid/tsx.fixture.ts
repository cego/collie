import { expect, test } from "bun:test";
import { View } from "./view.tsx";

test("a .tsx is compiled by Solid's transform", () =>
  expect(View.toString()).toContain("_$createElement"));
