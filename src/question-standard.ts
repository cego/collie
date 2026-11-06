// Whether an agent's question is to standard, what to tell it where it is not, and the
// solutions it reaches the Run as.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import type * as Types from "effect/Types";
import type { Solution } from "./board-model";
import type { AgentQuestion as AskedQuestion } from "./compactors";

/** Claude's own convention, which Codex and pi agents are told. */
export const RECOMMENDED_MARKER = " (Recommended)";

const isRecommended = Str.endsWith(RECOMMENDED_MARKER);
const titleOf = (label: string) =>
  isRecommended(label) ? Str.slice(0, -RECOMMENDED_MARKER.length)(label) : label;
const recommendedCount = (question: AskedQuestion) =>
  Arr.filter(question.options, (option) => isRecommended(option.label)).length;

const GAPS: ReadonlyArray<{
  readonly lacks: (question: AskedQuestion) => boolean;
  readonly shortfall: string;
  readonly repair: string;
}> = [
  {
    lacks: (question) => question.options.length < 3,
    shortfall: "at least three options",
    repair: "at least three options",
  },
  {
    lacks: (question) => recommendedCount(question) !== 1,
    shortfall: "exactly one recommended option",
    repair: `exactly one option whose label ends "${RECOMMENDED_MARKER}"`,
  },
  {
    lacks: (question) => question.multiSelect === true,
    shortfall: "one decision per question",
    repair:
      "one decision per question, so no multiSelect: ask each choice as a question of its own",
  },
  {
    lacks: (question) =>
      new Set(Arr.map(question.options, (option) => titleOf(option.label))).size !==
      question.options.length,
    shortfall: "options with different titles",
    repair: "no two options with the same label",
  },
];

const gapsOf = (question: AskedQuestion) => Arr.filter(GAPS, (gap) => gap.lacks(question));

const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 2
    ? Arr.join(parts, "")
    : `${Arr.join(parts.slice(0, -1), ", ")} and ${parts.at(-1)}`;

export const isToStandard = (question: AskedQuestion) => gapsOf(question).length === 0;

/** What tells the agent how to ask its call's questions again. */
export const questionRepair = (questions: ReadonlyArray<AskedQuestion>): string =>
  Arr.join(
    [
      "Collie did not post this question.",
      ...Arr.flatMap(questions, (question) => {
        const gaps = gapsOf(question);
        return gaps.length === 0
          ? []
          : [
              `"${question.header || question.question}" needs ${listed(Arr.map(gaps, (gap) => gap.repair))}.`,
            ];
      }),
      "Give each option a description of what it leads to, and make the alternatives genuine. For a permission question, offer distinct paths: proceed, defer, or change approach, each with its own consequence.",
      "Ask again: Collie posts your next question as you ask it.",
    ],
    " ",
  );

/** The flag on a question posted short of standard, or null where it is to standard. */
export const shortfallOf = (question: AskedQuestion): string | null => {
  const gaps = gapsOf(question);
  if (gaps.length === 0) return null;
  const count = question.options.length;
  const recommended = recommendedCount(question);
  const recommendation =
    recommended === 0
      ? "no recommendation"
      : recommended === 1
        ? "one recommendation"
        : `${recommended} recommendations`;
  return `The agent gave ${count} ${count === 1 ? "option" : "options"} and ${recommendation}; Collie asked for ${listed(Arr.map(gaps, (gap) => gap.shortfall))}.`;
};

/**
 * Its options as solutions numbered from 1, the one recommended first, without the
 * marker. More or fewer than one marked, none is recommended.
 */
export const solutionsOf = (question: AskedQuestion): ReadonlyArray<Solution> => {
  const one = recommendedCount(question) === 1;
  const ordered = one
    ? [
        ...Arr.filter(question.options, (option) => isRecommended(option.label)),
        ...Arr.filter(question.options, (option) => !isRecommended(option.label)),
      ]
    : question.options;
  return Arr.map(ordered, (option, at) => {
    const solution: Types.Mutable<Solution> = {
      id: String(at + 1),
      title: titleOf(option.label),
    };
    if (option.description !== undefined) solution.detail = option.description;
    if (one && isRecommended(option.label)) solution.recommended = true;
    return solution;
  });
};
