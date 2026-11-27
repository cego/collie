import { expect, test } from "bun:test";
import { Schema } from "effect";
import { FileIssueOutput } from "../workflows/file-issue.workflow";

const read = Schema.decodeUnknownResult(FileIssueOutput, { errors: "all" });

const said = (value: Schema.Json) => {
  const decoded = read(value);
  return decoded._tag === "Success" ? "" : decoded.failure.message;
};

test("a file-issue Run's Output is refused without the url a card opens the issue with", () => {
  expect(
    read({ identifier: "CEGO-12", url: "https://linear.app/cego/issue/CEGO-12/a-title" })._tag,
  ).toBe("Success");
  expect(said({ identifier: "CEGO-12" })).toContain("url");
  expect(said({ url: "https://linear.app/cego/issue/CEGO-12/a-title" })).toContain("identifier");
});
