import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { leaksIn, refusal } from "../src/public-text";
import leaking from "./fixtures/public-text/mr-522-note-1839712.md" with { type: "text" };
import nit from "./fixtures/public-text/mr-522-note-1837798.md" with { type: "text" };
import important from "./fixtures/public-text/mr-522-note-1839274.md" with { type: "text" };
import chat from "../prompts/collie-chat.md" with { type: "text" };
import releaseOnGitlab from "../workflows/release.gitlab.md" with { type: "text" };
import releaseOnGithub from "../workflows/release.github.md" with { type: "text" };
import tuneUp from "../workflows/tune-up.md" with { type: "text" };
import { systemPrompt } from "../desktop/src/bun/session";

const phrases = (text: string) => Arr.map(leaksIn(text), (leak) => leak.phrase);

test.each([
  ["Reviewed by Collie before merge.", "Collie"],
  ["This follows Collie's evidence rule.", "Collie"],
  ["Run collie verify --expect fail on it.", "collie verify"],
  ["Start it with collie run start review.", "collie run"],
  ["See run-67a6e669 for the record.", "run-67a6e669"],
  ["Built by run-71558ed9.implement.implement-. last night.", "run-71558ed9.implement.implement-."],
  ["This Run records no failing execution.", "This Run"],
  ["Nothing in this Run proves it.", "this Run"],
  ["It was recorded by the Run before merge.", "the Run"],
  ["A Run would have caught it.", "A Run"],
  ["These are comment Tautologies.", "Tautologies"],
  ["The test is tautological.", "tautological"],
  ["The review-step rule requires it.", "review-step"],
  ["Failing-first evidence is missing.", "Failing-first"],
  ["Not settled by the run: the cache size.", "Not settled by the run"],
  ["The size is assumed in 01-the-cache.md.", "assumed in 01-"],
  ["See 02-a-review-posts-its-public-rendering.md.", "02-a-review-posts-its-public-rendering.md"],
  ["Its log is in /home/mk/.local/state/herdr/plugins/cego.collie/runs/x.", "/herdr/plugins/"],
  ["The checks live in .collie/verify.json.", ".collie/"],
  ["Posted by Collie's Run r1 on vm-mk.", "Posted by Collie"],
])("%p is refused for %p", (sentence, phrase) => {
  expect(phrases(sentence)).toContain(phrase);
  expect(refusal(leaksIn(sentence))).toContain(`"${phrase}"`);
});

test("the !522 note is refused for each phrase that named Collie's process", () => {
  expect(phrases(leaking)).toEqual(
    expect.arrayContaining([
      "Failing-first",
      "this Run",
      "review-step",
      "collie verify",
      "Tautologies",
    ]),
  );
});

test("a colleague's review notes pass unchanged", () => {
  expect(leaksIn(nit)).toEqual([]);
  expect(leaksIn(important)).toEqual([]);
});

test.each([
  "The next step is to reset the cooldown.",
  "The user agent header is missing.",
  "The card component keeps its own state.",
  "Run the tests again once the fix lands.",
  "The run took four minutes.",
  "The collie is a herding dog.",
])("%p passes", (sentence) => {
  expect(leaksIn(sentence)).toEqual([]);
});

test("each leak is given once, with why it leaks", () => {
  const leaks = leaksIn("Ask this Run, then this Run again.");
  expect(Arr.map(leaks, (leak) => leak.phrase)).toEqual(["this Run"]);
  for (const leak of leaks) expect(leak.reason).not.toBe("");
});

test.each([
  ["chat", chat],
  ["Desktop's chat", systemPrompt("laptop")],
  ["release's answers on GitLab", releaseOnGitlab],
  ["release's answers on GitHub", releaseOnGithub],
  ["tune-up's Linear issue", tuneUp],
])("%s states the Public text contract for what Collie does not carry", (_, prompt) => {
  expect(pipe(prompt, Str.replace(/\s+/g, " "))).toContain(
    "Public text is what goes outside Collie in the human's name: a merge request note or reply, an issue or comment in another repository, a Slack message, a Linear issue. Write it as the human would for that repository's readers. It never names Collie, a Run, a step, an agent, a card or a `collie` command, and never holds anyone to a rule only Collie's process has.",
  );
});
