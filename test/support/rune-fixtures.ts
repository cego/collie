// What the Rune spike is tested against: a Flock of two live Machines with five cards between
// them, one Machine out of reach and one only saved, as `flock` streams it.

import type { AguiEvent } from "../../desktop/src/shared/agui";
import type { FlockItem } from "../../desktop/src/shared/flock";
import { task } from "./task";

const local = { installation: "inst-local", profile: "local", name: "Local" };
const build = {
  installation: "inst-build",
  profile: "build",
  name: "Build box",
  target: "mk@build",
  route: "ssh" as const,
};

const snapshot = (
  machine: typeof local | typeof build,
  tasks: ReadonlyArray<ReturnType<typeof task>>,
): FlockItem => ({
  machine,
  message: {
    _tag: "Snapshot",
    installation: machine.installation,
    build: "0.118.0",
    protocol: 7,
    files: true,
    herds: [{ id: "h1", name: "main" }, { id: "h2" }],
    tasks,
    seq: 1,
  },
});

export const FLOCK: ReadonlyArray<FlockItem> = [
  { _tag: "Routes", profiles: ["local", "build", "laptop", "studio"] },
  { _tag: "Routed", machine: { profile: "local", name: "Local" } },
  snapshot(local, [
    task({ id: "t1", name: "Strapi prod seeder", herd: "h1" }),
    task({
      id: "t2",
      name: "Fix the login redirect",
      state: "blocked",
      decision: {
        kind: "question",
        run: "r2",
        id: "c1",
        step: "plan",
        topic: "the redirect",
        text: "Keep the old path working?",
        options: [
          { id: "yes", title: "Yes", subtitle: "Redirect it" },
          { id: "no", title: "No", subtitle: null },
        ],
      },
      agents: [{ name: "planner-1", role: "planner", status: "blocked", now: null, run: "r2" }],
      unseen: true,
    }),
    task({
      id: "t3",
      name: "Release 0.119.0",
      state: "done",
      mr: "https://gitlab.example/collie/-/merge_requests/301",
      mrState: "merged",
      checks: { state: "passed", at: "2026-11-05T10:00:00Z" },
      disposition: "merged",
      children: [{ repo: "collie", run: "r3", state: "done", mr: null }],
      ended: 1_793_900_000_000,
    }),
  ]),
  snapshot(build, [
    task({
      id: "b1",
      name: "Nightly evidence sweep",
      held: "⏸ Held until 14:00.",
      heldBy: { by: "mk", reason: "waiting for the deploy" },
      checks: { state: "failed", name: "test", at: "2026-11-05T11:00:00Z" },
    }),
    task({ id: "b2", name: "Bump effect to 4.2", state: "quiet", drift: "2 commits behind" }),
  ]),
  {
    machine: build,
    message: {
      _tag: "Upsert",
      seq: 2,
      task: task({ id: "b2", name: "Bump effect to 4.2", state: "active" }),
    },
  },
  {
    _tag: "Lost",
    machine: { profile: "laptop", name: "Laptop", target: "mk@laptop", route: "link" },
    state: "unreachable",
    reason: "ssh: connect to host laptop port 22: No route to host",
    at: 1_793_900_100_000,
  },
  {
    _tag: "Saved",
    machine: { installation: "inst-studio", profile: "studio", name: "Studio" },
    herds: [{ id: "h1" }],
    tasks: [task({ id: "s1", name: "Port the Flow map", herd: "h1" })],
    build: "0.117.0",
    at: 1_793_800_000_000,
  },
  {
    _tag: "Notice",
    machine: { profile: "build", name: "Build box" },
    text: "Upgraded Build box to 0.118.0",
  },
];

/** One turn of the Flock chat, as `say` streams it, with an event of every AG-UI kind. */
export const SAID: ReadonlyArray<AguiEvent> = [
  { type: "RUN_STARTED", threadId: "conv-1", runId: "turn-1" },
  { type: "REASONING_START", messageId: "r1" },
  { type: "REASONING_MESSAGE_START", messageId: "r1", role: "reasoning" },
  { type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "Look at the board first." },
  { type: "REASONING_MESSAGE_END", messageId: "r1" },
  { type: "REASONING_END", messageId: "r1" },
  { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Two cards are **blocked**." },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "board", parentMessageId: "m1" },
  { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"machine":"local"}' },
  { type: "TOOL_CALL_END", toolCallId: "c1" },
  {
    type: "TOOL_CALL_RESULT",
    toolCallId: "c1",
    messageId: "c1-result",
    content: "t2 blocked",
    role: "tool",
  },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  { type: "RUN_FINISHED", threadId: "conv-1", runId: "turn-1" },
  { type: "RUN_ERROR", runId: "", message: "The chat's model is not set" },
];
