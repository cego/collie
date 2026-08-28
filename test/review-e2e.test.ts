import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { REVIEW_FILE } from "../src/output";

let rig: Rig;
let bin: FakeBin;

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
  installBaseline(rig);
  bin = new FakeBin(join(rig.root, "bin"));
});

afterEach(async () => {
  bin.restore();
  await rig.close();
});

const CLEAN = { verdict: "clean", findings: [] };
const SYNTH = { ...CLEAN, summary: "A one-file change to the CLI. Nothing wrong with it." };

/** review fans out to opus and sonnet, so a prompt lives under its variant. */
function promptOf(run: { dir: string }, variant = "claude-opus"): string {
  return readFileSync(join(run.dir, "steps", "review", variant, "prompt-1.md"), "utf8");
}

/** A glab that answers `mr view` and appends every note it is asked to post. */
function fakeGlab(iid: number): void {
  const notes = join(rig.root, "bin", "notes.txt");
  bin.add(
    "glab",
    `case "$1 $2" in
      "--version ") echo "glab 1.40.0" ;;
      "mr view") echo '{"iid": ${iid}, "state": "opened"}' ;;
      "mr note") shift 2; printf '%s\\n' "$@" >> ${notes} ;;
      *) exit 1 ;;
    esac`,
  );
  bin.add(
    "git",
    `case "$1 $2" in
      "remote -v") echo "origin\tgit@gitlab.cego.dk:cego/herdr-plugin.git (fetch)" ;;
      *) echo main ;;
    esac`,
  );
}

test("review runs standalone on the inferred target, and post is no longer an input", async () => {
  bin.add("glab", `echo '{"iid": 12, "state": "opened"}'`);
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);
  const prompts = scriptedPrompts(["Don't post"]);

  const { run, status } = await runWorkflow(rig, "review", {}, { prompts });

  expect(status).toBe("done");
  // The kind is recorded next to the value, so a prompt can branch on it.
  expect(run.record.inputs).toEqual({ target: "mr:12", target_kind: "mr" });
  expect(run.record.input_sources).toEqual({ target: "open merge request !12" });

  const prompt = promptOf(run);
  expect(prompt).toContain("Review target: mr:12");
  expect(prompt).not.toContain("Post to GitLab");
  expect(prompt).toContain(
    `OUTPUT_PATH: ${join(run.dir, "steps", "review", "claude-opus", "review.json")}`,
  );

  // Same persona, two models: that is the whole difference between the variants.
  const starts = rig.calls().filter((c) => c.cmd === "agent start");
  expect(starts.map((c) => c.argv!.slice(8))).toEqual([
    ["--model", "opus", "--effort", "medium", "--append-system-prompt-file", join(run.dir, "personas", "reviewer.md")],
    ["--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", join(run.dir, "personas", "reviewer.md")],
    ["--model", "sonnet", "--append-system-prompt-file", join(run.dir, "personas", "reviewer.md")],
  ]);
  expect(readFileSync(join(run.dir, "personas", "reviewer.md"), "utf8")).toContain("You are a reviewer");
});

test("the synthesiser is handed every reviewer's Output and writes one review", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  const opus = {
    verdict: "findings",
    findings: [{ file: "cli.js", line: 4, severity: "blocker", title: "no exit code", detail: "returns 1" }],
  };
  const sonnet = {
    verdict: "findings",
    findings: [{ file: "cli.js", line: 9, severity: "minor", title: "loose equality" }],
  };
  const synthesized = {
    verdict: "findings",
    summary: "Adds a --version flag to the CLI. One blocker: it exits with the wrong code.",
    findings: [
      { file: "cli.js", line: 4, severity: "blocker", title: "The exit code is 1 on success", detail: "A caller cannot tell it worked." },
      { file: "cli.js", line: 9, severity: "minor", title: "Loose equality on the flag" },
    ],
    dropped: [{ file: "cli.js", severity: "minor", title: "no engines field", reason: "packaging is out of this branch's scope" }],
  };
  rig.queueOutputs([opus, sonnet, synthesized]);

  const { run, status, lines } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  // The prompt names both reviews by path; the synthesiser reads them itself.
  const prompt = readFileSync(join(run.dir, "steps", "synthesize", "prompt-1.md"), "utf8");
  expect(prompt).toContain(`- ${join(run.dir, "steps", "review", "claude-opus", "review.json")}`);
  expect(prompt).toContain(`- ${join(run.dir, "steps", "review", "claude-sonnet", "review.json")}`);
  expect(prompt).toContain("Never say which model or which skill found it");
  expect(prompt).toContain(`OUTPUT_PATH: ${join(run.dir, "steps", "synthesize", "synthesized.json")}`);

  // One review comes out, rendered for a human and printed where they are looking.
  const review = readFileSync(join(run.dir, REVIEW_FILE), "utf8");
  expect(review).toBe(
    [
      "Adds a --version flag to the CLI. One blocker: it exits with the wrong code.",
      "",
      "**Blocker**",
      "",
      "- `cli.js:4` — The exit code is 1 on success",
      "  A caller cannot tell it worked.",
      "",
      "**Minor**",
      "",
      "- `cli.js:9` — Loose equality on the flag",
      "",
    ].join("\n"),
  );
  expect(lines.join("\n")).toContain(review.trimEnd());
  // Nothing about the process or the models reaches the human-facing review.
  expect(review).not.toContain("dropped");
  expect(review).not.toContain("opus");
  expect(review.split("\n")).toHaveLength(11);
});

test("the synthesis pane opens under the reviewers, in their tab", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);

  const { run } = await runWorkflow(rig, "review", {});

  const reviewers = run.step("review").variants;
  const synth = run.step("synthesize").variants[0]!;
  expect(synth.tabId).toBe(reviewers[1]!.tabId);
  expect(synth.paneId).not.toBe(reviewers[1]!.paneId);

  // Down, not right: a third column would leave all three unreadable.
  const split = rig
    .calls()
    .filter((c) => c.cmd === "pane split")
    .find((c) => c.argv![2] === reviewers[1]!.paneId)!;
  expect(split.argv!.slice(3, 7)).toEqual(["--direction", "down", "--ratio", "0.5"]);
  // One tab for the whole run: the reviewers', which the synthesis joins.
  expect(rig.cmds().filter((c) => c === "tab create")).toHaveLength(1);
  expect(rig.calls().filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1))).toContain("Synthesize");
});

test("a synthesis without a summary, or a dropped finding without a reason, fails the step", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([CLEAN, CLEAN, CLEAN]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("blocked");
  expect(run.step("synthesize").variants[0]!.error).toBe("steps/synthesize/synthesized.json: summary is required");
  expect(existsSync(join(run.dir, REVIEW_FILE))).toBe(false);
});

test("an MR target offers the post choice, and Post sends review.md as one note", async () => {
  fakeGlab(12);
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);
  const prompts = scriptedPrompts(["Post to MR"]);

  const { run, status, lines } = await runWorkflow(rig, "review", {}, { prompts });

  expect(status).toBe("done");
  expect(prompts.offered).toEqual([["Post to MR", "Don't post"]]);
  expect(run.step("post").note).toBe(`chose "Post to MR" — posted the review to !12`);
  expect(lines).toContain("  posted the review to !12");

  // Exactly one note, and it is review.md character for character.
  const posted = readFileSync(join(rig.root, "bin", "notes.txt"), "utf8");
  expect(posted).toBe(`12\n--message\n${readFileSync(join(run.dir, REVIEW_FILE), "utf8")}\n`);
});

test("Don't post leaves the merge request alone", async () => {
  fakeGlab(12);
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);
  const prompts = scriptedPrompts(["Don't post"]);

  const { run, status } = await runWorkflow(rig, "review", {}, { prompts });

  expect(status).toBe("done");
  expect(run.step("post").note).toBe(`chose "Don't post"`);
  expect(existsSync(join(rig.root, "bin", "notes.txt"))).toBe(false);
});

test("a note that will not send re-offers the menu instead of ending the step", async () => {
  bin.add("glab", `case "$1 $2" in "--version ") echo "glab 1.40.0" ;; "mr view") echo '{"iid": 12, "state": "opened"}' ;; *) exit 3 ;; esac`);
  bin.add("git", `case "$1 $2" in "remote -v") echo "origin\tgit@gitlab.cego.dk:cego/x.git (fetch)" ;; *) echo main ;; esac`);
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);
  const prompts = scriptedPrompts(["Post to MR", "Don't post"]);

  const { status, lines } = await runWorkflow(rig, "review", {}, { prompts });

  expect(status).toBe("done");
  expect(lines).toContain("  glab mr note !12 failed (exit 3)");
  expect(prompts.offered).toHaveLength(2);
});

test("a branch target writes the review and skips the choice entirely", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `case "$1 $2" in "rev-parse --abbrev-ref") echo feature ;; *) echo main ;; esac`);
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);

  const { run, status, lines } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  expect(run.record.inputs.target_kind).toBe("branch");
  expect(run.step("post").note).toBe("skipped: branch:main...feature is not a merge request");
  expect(lines).toContain("◦ post — skipped: branch:main...feature is not a merge request");
  // The review is still written, and still printed for the human.
  expect(readFileSync(join(run.dir, REVIEW_FILE), "utf8")).toContain("Nothing to fix.");
  expect(lines.join("\n")).toContain("Nothing to fix.");
});

test("a review.json that breaks the Output schema fails the step with the schema error", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([{ verdict: "findings", findings: [] }, CLEAN, SYNTH]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("blocked");
  expect(run.record.steps[0]!.variants[0]!.status).toBe("failed");
  expect(run.record.steps[0]!.variants[0]!.error).toBe(
    'steps/review/claude-opus/review.json: verdict "findings" with an empty findings list',
  );
});

test("the working tree is the last resort target", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);

  const { run } = await runWorkflow(rig, "review", {});

  expect(run.record.inputs.target).toBe("worktree");
  expect(promptOf(run)).toContain("Review target: worktree");
});
