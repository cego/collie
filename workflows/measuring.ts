import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { contentOf } from "collie";
import markdown from "./measuring.md" with { type: "text" };

const content = contentOf(markdown);

export const measuredBy = (lead: string, benchmark: string) =>
  `\n\n${pipe(
    `${Str.trim(content.sections.get(lead) ?? "")}\n${Str.trim(content.sections.get("measure.steps") ?? "")}`,
    Str.replaceAll("{{benchmark}}", benchmark),
  )}`;
