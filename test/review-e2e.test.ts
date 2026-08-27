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

function promptOf(run: { dir: string }): string {
  return readFileSync(join(run.dir, "steps", "review", "prompt-1.md"), "utf8");
}

test("review runs standalone on the inferred target with post off by default", async () => {
  bin.add("glab", `echo '{"iid": 12, "state": "opened"}'`);
  rig.queueOutputs([{ verdict: "clean", findings: [] }]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  expect(run.record.inputs).toEqual({ target: "mr:12", post: "false" });
  expect(run.record.input_sources).toEqual({ target: "open merge request !12", post: "default" });

  const prompt = promptOf(run);
  expect(prompt).toContain("Review target: mr:12");
  expect(prompt).toContain("Post to GitLab: false");
  expect(prompt).toContain(`OUTPUT_PATH: ${join(run.dir, "steps", "review", "review.json")}`);

  const start = rig.calls().find((c) => c.cmd === "agent start")!.argv!;
  expect(start[11]).toBe(join(run.dir, "personas", "reviewer.md"));
  expect(readFileSync(start[11]!, "utf8")).toContain("You are a reviewer");
});

test("post is only true when the human asks for it", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([{ verdict: "clean", findings: [] }]);

  const { run } = await runWorkflow(rig, "review", { post: "true" });

  expect(run.record.inputs.post).toBe("true");
  expect(promptOf(run)).toContain("Post to GitLab: true");
});

test("findings are recorded and the run still finishes; review is not a gate on its own", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([
    {
      verdict: "findings",
      findings: [{ file: "cli.js", line: 4, severity: "blocker", title: "no exit code", detail: "returns 1" }],
    },
  ]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  const output = JSON.parse(readFileSync(join(run.dir, "steps", "review", "review.json"), "utf8"));
  expect(output.findings[0].title).toBe("no exit code");
  expect(run.record.steps[0]!.variants[0]!.output).toBe("steps/review/review.json");
});

test("a review.json that breaks the Output schema fails the step with the schema error", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([{ verdict: "findings", findings: [] }]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("blocked");
  expect(run.record.steps[0]!.variants[0]!.status).toBe("failed");
  expect(run.record.steps[0]!.variants[0]!.error).toBe(
    'steps/review/review.json: verdict "findings" with an empty findings list',
  );
});

test("the working tree is the last resort target", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  rig.queueOutputs([{ verdict: "clean", findings: [] }]);

  const { run } = await runWorkflow(rig, "review", {});

  expect(run.record.inputs.target).toBe("worktree");
  expect(promptOf(run)).toContain("Review target: worktree");
});
