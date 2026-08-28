import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow } from "./support/engine";

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

/** review fans out to opus and sonnet, so a prompt lives under its variant. */
function promptOf(run: { dir: string }, variant = "claude-opus"): string {
  return readFileSync(join(run.dir, "steps", "review", variant, "prompt-1.md"), "utf8");
}

test("review runs standalone on the inferred target with post off by default", async () => {
  bin.add("glab", `echo '{"iid": 12, "state": "opened"}'`);
  rig.queueOutputs([{ verdict: "clean", findings: [] }, { verdict: "clean", findings: [] }]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  // The kind is recorded next to the value, so a prompt can branch on it.
  expect(run.record.inputs).toEqual({ target: "mr:12", target_kind: "mr", post: "false" });
  expect(run.record.input_sources).toEqual({ target: "open merge request !12", post: "default" });

  const prompt = promptOf(run);
  expect(prompt).toContain("Review target: mr:12");
  expect(prompt).toContain("Post to GitLab: false");
  expect(prompt).toContain(
    `OUTPUT_PATH: ${join(run.dir, "steps", "review", "claude-opus", "review.json")}`,
  );

  // Same persona, two models: that is the whole difference between the variants.
  const starts = rig.calls().filter((c) => c.cmd === "agent start");
  expect(starts.map((c) => c.argv!.slice(8))).toEqual([
    ["--model", "opus", "--effort", "xhigh", "--append-system-prompt-file", join(run.dir, "personas", "reviewer.md")],
    ["--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", join(run.dir, "personas", "reviewer.md")],
  ]);
  expect(readFileSync(join(run.dir, "personas", "reviewer.md"), "utf8")).toContain("You are a reviewer");
});

test("post is only true when the human asks for it", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([{ verdict: "clean", findings: [] }, { verdict: "clean", findings: [] }]);

  const { run } = await runWorkflow(rig, "review", { post: "true" });

  expect(run.record.inputs.post).toBe("true");
  expect(promptOf(run)).toContain("Post to GitLab: true");
});

test("findings are recorded and the run still finishes; review is not a gate on its own", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  const finding = {
    verdict: "findings",
    findings: [{ file: "cli.js", line: 4, severity: "blocker", title: "no exit code", detail: "returns 1" }],
  };
  rig.queueOutputs([finding, finding]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  const output = JSON.parse(
    readFileSync(join(run.dir, "steps", "review", "claude-opus", "review.json"), "utf8"),
  );
  expect(output.findings[0].title).toBe("no exit code");
  expect(run.record.steps[0]!.variants[0]!.output).toBe("steps/review/claude-opus/review.json");
});

test("a review.json that breaks the Output schema fails the step with the schema error", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([{ verdict: "findings", findings: [] }, { verdict: "clean", findings: [] }]);

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
  rig.queueOutputs([{ verdict: "clean", findings: [] }, { verdict: "clean", findings: [] }]);

  const { run } = await runWorkflow(rig, "review", {});

  expect(run.record.inputs.target).toBe("worktree");
  expect(promptOf(run)).toContain("Review target: worktree");
});
