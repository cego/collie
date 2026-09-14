import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Herdr, type AgentInfo } from "../src/herdr";
import { registerAgent, registryPath, scopeFor, type AgentEntry } from "../src/registry";
import { EffectFakeHerdr, installBaseline, runWorkflow } from "./support/engine";
import { writeDef } from "./support/defs";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const session = { kind: "path", value: "/sessions/interview.jsonl" };
const entry: AgentEntry = {
  role: "planner",
  agent: "plan-grill",
  paneId: "w1:p1",
  workspaceId: "w1",
  runId: "r1",
  workflow: "plan",
  at: "2026-09-14T09:00:00Z",
  incarnation: { terminalId: "terminal-1", agentSession: session },
};
const live = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  agent_status: "idle",
  terminal_id: "terminal-1",
  agent_session: { ...session, source: "herdr:pi", agent: "pi" },
};

type AgentSnapshot = {
  pane_id: string;
  workspace_id: string;
  agent_status: string;
  terminal_id: string;
  agent_session: typeof live.agent_session | null;
  name?: string;
};

class RecoveryHerdr extends Herdr {
  readonly calls: string[][] = [];
  constructor(private readonly reply: AgentSnapshot) {
    super(rig.pluginEnv());
  }
  protected override exec(args: string[]) {
    this.calls.push(args);
    return Effect.succeed({
      code: 0,
      stdout: JSON.stringify(args[1] === "get" ? { result: { agent: this.reply } } : {}),
      stderr: "",
    });
  }
}

test("an unnamed live session regains its original managed name", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new RecoveryHerdr(live);
      expect(yield* herdr.restoreAgentName(entry)).toBe(true);
      expect(herdr.calls).toEqual([
        ["agent", "get", "w1:p1"],
        ["agent", "rename", "w1:p1", "plan-grill"],
      ]);
    }),
  ));

test("a rejected name restoration is a failure, not a recovered agent", () =>
  runEffect(
    Effect.gen(function* () {
      class RejectedRename extends RecoveryHerdr {
        protected override exec(args: string[]) {
          const response = super.exec(args);
          return args[1] === "rename"
            ? Effect.succeed({
                code: 0,
                stderr: "",
                stdout: JSON.stringify({
                  error: { code: "agent_name_taken", message: "name already in use" },
                }),
              })
            : response;
        }
      }
      const result = yield* Effect.result(new RejectedRename(live).restoreAgentName(entry));
      expect(result._tag).toBe("Failure");
    }),
  ));

for (const [reason, reply] of Object.entries({
  "replaced terminal": { ...live, terminal_id: "terminal-2" },
  "different session": {
    ...live,
    agent_session: { ...live.agent_session, value: "/sessions/other.jsonl" },
  },
  "missing session": { ...live, agent_session: null },
  "different pane": { ...live, pane_id: "w1:p2" },
  "different workspace": { ...live, workspace_id: "w2" },
  "human rename": { ...live, name: "do-not-overwrite" },
})) {
  test("name recovery refuses a " + reason, () =>
    runEffect(
      Effect.gen(function* () {
        const herdr = new RecoveryHerdr(reply);
        expect(yield* herdr.restoreAgentName(entry)).toBe(false);
        expect(herdr.calls.some((args) => args[1] === "rename")).toBe(false);
      }),
    ),
  );
}

test("legacy entries without a saved session cannot reclaim a pane", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new RecoveryHerdr(live);
      expect(
        yield* herdr.restoreAgentName({
          ...entry,
          incarnation: { terminalId: "terminal-1", agentSession: null },
        }),
      ).toBe(false);
      expect(herdr.calls).toEqual([]);
    }),
  ));

test("grill to spec keeps the same agent after losing its name and registry role", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.startSocket();
      yield* installBaseline(rig);
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "continuation",
        `---
name: continuation
steps:
  - id: grill
    persona: planner
    output: grill.json
  - id: spec
    agent: grill
    persona: planner
    output: spec.json
---
## grill
Interview, then write the Output.
## spec
Write the spec, then the Output.
`,
      );
      yield* rig.queueOutputs([
        { verdict: "clean", findings: [] },
        { verdict: "clean", findings: [] },
      ]);
      const env = rig.pluginEnv();
      class LostNameHerdr extends EffectFakeHerdr {
        lost = false;
        didLose = false;
        restored = 0;
        captured: AgentInfo | undefined;
        override agentList() {
          return super.agentList().pipe(
            Effect.map((agents) => {
              const listed = agents.map((agent) => ({ ...agent, agentSession: session }));
              this.captured ??= listed[0];
              return this.lost ? [] : listed;
            }),
          );
        }
        override agentPrompt(target: string, text: string) {
          return super.agentPrompt(target, text).pipe(
            Effect.tap(() => {
              if (this.didLose) return Effect.void;
              this.lost = this.didLose = true;
              // Another plan in the same workspace takes over the planner registry role.
              return registryPath(env.stateDir, scopeFor(env, env.cwd)).pipe(
                Effect.flatMap((file) =>
                  registerAgent(file, {
                    ...entry,
                    agent: "another-plan",
                    runId: "another-run",
                  }),
                ),
                Effect.asVoid,
                Effect.orDie,
              );
            }),
          );
        }
        protected override exec(args: string[]) {
          const current = this.captured;
          if (
            this.lost &&
            current &&
            args[0] === "agent" &&
            args[1] === "get" &&
            args[2] === current.paneId
          ) {
            return Effect.succeed({
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                result: {
                  agent: {
                    ...live,
                    pane_id: current.paneId,
                    workspace_id: current.workspaceId,
                    terminal_id: current.terminalId,
                  },
                },
              }),
            });
          }
          if (args[0] === "agent" && args[1] === "rename") {
            this.lost = false;
            this.restored++;
            return Effect.succeed({ code: 0, stderr: "", stdout: "{}" });
          }
          return super.exec(args);
        }
      }
      const herdr = new LostNameHerdr(env, rig.env());
      const result = yield* runWorkflow(rig, "continuation", {}, { herdr });
      expect(result.status).toBe("done");
      expect(herdr.restored).toBe(1);
      const first = result.run.step("grill").variants[0]!;
      const next = result.run.step("spec").variants[0]!;
      expect(next.agent).toBe(first.agent);
      expect(next.tabId).toBe(first.tabId);
      expect(next.paneId).toBe(first.paneId);
      expect(next.incarnation).toEqual(first.incarnation);
      expect(first.incarnation?.agentSession).toEqual(session);
      expect((yield* rig.calls()).filter((call) => call.cmd === "agent start")).toHaveLength(1);
    }),
  ));
