// Every board action, pressed in the built app and carried to the scripted host of the
// Machine its card is on. What each host was asked is read back from its log.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Schema } from "effect";
import type { Locator } from "playwright-core";
import type { TaskView } from "../../src/board-model";
import { task } from "../../test/support/task";
import { type App, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";
import { REFUSED_RUN } from "./support/scripted-machine";

const VM = "mk@vm-mk.json";
const LONG = Array.from(
  { length: 80 },
  (_, at) => `Line ${at + 1} of why this is the right correction.`,
);

// Recent, so nothing is folded away under Waiting on you's week.
let now = 0;
const recent = (over: Partial<TaskView>) => task({ at: now, ...over });
const blocked = (over: Partial<TaskView>) => recent({ state: "blocked", ...over });

const local = (): ReadonlyArray<TaskView> => [
  blocked({
    id: "t-typed",
    name: "Name the branch",
    run: "r-typed",
    decision: {
      kind: "question",
      run: "r-typed",
      id: "q-typed",
      step: "plan",
      topic: "branch",
      text: "Which branch?",
      options: [],
    },
  }),
  blocked({
    id: "t-gate",
    name: "Approve the checks",
    run: "r-gate",
    decision: {
      kind: "gate",
      run: "r-gate",
      id: "evidence-gate",
      step: "verify",
      verifications: ["unit", "lint"],
    },
  }),
  blocked({
    id: "t-prop",
    name: "A long correction",
    run: "r-prop",
    decision: {
      kind: "proposal",
      id: "p-long",
      hash: "h-long",
      text: LONG.join("\n"),
      actions: [{ text: "Stop r-prop", allowed: true }],
    },
  }),
  blocked({
    id: "t-prop2",
    name: "A short correction",
    run: "r-prop2",
    decision: {
      kind: "proposal",
      id: "p-short",
      hash: "h-short",
      text: "Hold it.",
      actions: [{ text: "Hold r-prop2", allowed: true }],
    },
  }),
  recent({ id: "t-work", name: "Fix the seeder", state: "active", run: "r-work" }),
  recent({
    id: "t-held",
    name: "Waiting for lunch",
    state: "active",
    run: "r-held",
    held: "⏸ Held.",
  }),
  recent({ id: "t-failed", name: "Broke the build", state: "failed", run: "r-failed" }),
  recent({ id: "t-refused", name: "Cannot come back", state: "failed", run: REFUSED_RUN }),
  recent({
    id: "t-done",
    name: "Shipped the seeder",
    state: "done",
    landed: false,
    run: "r-done",
    mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/151",
  }),
  recent({
    id: "t-plan",
    name: "A plan, ready",
    state: "done",
    landed: false,
    run: "r-plan",
    planReady: true,
    offer: { id: "build-it", title: "Build these tickets" },
  }),
];

const remote = (): ReadonlyArray<TaskView> => [
  blocked({
    id: "t-vm",
    name: "Pick a base",
    run: "r-vm",
    decision: {
      kind: "question",
      run: "r-vm",
      id: "q-base",
      step: "plan",
      topic: "base",
      text: "Which base?",
      options: [
        { id: "main", title: "main", subtitle: null },
        { id: "dev", title: "dev", subtitle: null },
      ],
    },
  }),
];

let app: App | undefined;

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        now = yield* Clock.currentTimeMillis;
        app = yield* launch(
          [{ label: "build box", target: "mk@vm-mk", session: "default", enabled: true }],
          (flock) =>
            Effect.gen(function* () {
              yield* serve(`${flock}/${LOCAL}`, "pc", local());
              yield* serve(`${flock}/${VM}`, "vm", remote());
            }),
        );
      }),
    ),
  120_000,
);

afterAll(() => run(quit(app)));

const Asked = Schema.fromJsonString(
  Schema.Struct({ op: Schema.String, payload: Schema.Record(Schema.String, Schema.Unknown) }),
);

/** How far into each host's log the tests have read. */
const read = new Map<string, number>();

/** The next thing the host behind `board` was asked to do of this kind, once it has been. */
const asked = (board: string, op: string) =>
  settled(`${board} asked to ${op}`, () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const log = yield* fs
          .readFileString(`${app!.flock}/${board}.ops.jsonl`)
          .pipe(Effect.orElseSucceed(() => ""));
        const lines = log.trim() === "" ? [] : log.trim().split("\n");
        const from = read.get(board) ?? 0;
        const at = lines.findIndex(
          (line, index) => index >= from && Schema.decodeSync(Asked)(line).op === op,
        );
        if (at === -1) return undefined;
        read.set(board, at + 1);
        return Schema.decodeSync(Asked)(lines[at]!).payload;
      }),
    ),
  );

const card = (id: string) => app!.page.getByTestId(`card-${id}`);
const press = (locator: Locator) => Effect.promise(() => locator.click());
const fromMenu = (id: string, item: string) =>
  Effect.gen(function* () {
    yield* press(card(id).getByTestId("menu"));
    yield* press(app!.page.getByRole("menuitem", { name: item }));
  });
const say = (words: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => app!.page.getByTestId("words").fill(words));
    yield* press(app!.page.getByTestId("send"));
  });

test(
  "an answer on another Machine lands on its host, and the card moves on from its stream",
  () =>
    run(
      Effect.gen(function* () {
        yield* press(card("t-vm").getByTestId("option-dev"));
        expect(yield* asked(VM, "answer")).toMatchObject({
          runId: "r-vm",
          decision: "q-base",
          value: "dev",
        });
        yield* reads(
          app!.page.getByTestId("working").getByTestId("card-t-vm").getByTestId("sentence"),
          "Carrying on.",
        );
      }),
    ),
  30_000,
);

test(
  "a question typed into is answered with what was typed",
  () =>
    run(
      Effect.gen(function* () {
        yield* Effect.promise(() => card("t-typed").getByTestId("answer").fill("mk/seed"));
        yield* press(card("t-typed").getByTestId("send-answer"));
        expect(yield* asked(LOCAL, "answer")).toMatchObject({
          runId: "r-typed",
          decision: "q-typed",
          value: "mk/seed",
        });
      }),
    ),
  30_000,
);

test(
  "a gate approves the checks still ticked",
  () =>
    run(
      Effect.gen(function* () {
        yield* press(card("t-gate").getByTestId("check-lint"));
        yield* press(card("t-gate").getByTestId("approve"));
        expect(yield* asked(LOCAL, "answer")).toMatchObject({
          runId: "r-gate",
          decision: "evidence-gate",
          value: "approve:unit",
        });
      }),
    ),
  30_000,
);

test(
  "a proposal is confirmed only once all of it has been shown, by its id and hash",
  () =>
    run(
      Effect.gen(function* () {
        const { page } = app!;
        yield* press(card("t-prop").getByTestId("review"));
        const confirm = page.getByTestId("confirm");
        yield* settled("the drawer", () =>
          confirm.isVisible().then((shown) => (shown ? true : undefined)),
        );
        expect(yield* Effect.promise(() => confirm.isDisabled())).toBe(true);
        yield* Effect.promise(() =>
          page.getByTestId("proposal-content").evaluate((content) => {
            content.scrollTop = content.scrollHeight;
          }),
        );
        yield* settled("Confirm enabled", () =>
          confirm.isEnabled().then((on) => (on ? true : undefined)),
        );
        yield* press(confirm);
        expect(yield* asked(LOCAL, "confirm")).toMatchObject({
          proposal: "p-long",
          hash: "h-long",
        });
      }),
    ),
  30_000,
);

test(
  "a proposal shown whole can be confirmed at once, and declined by its id and hash",
  () =>
    run(
      Effect.gen(function* () {
        const { page } = app!;
        yield* press(card("t-prop2").getByTestId("review"));
        yield* settled("Confirm enabled", () =>
          page
            .getByTestId("confirm")
            .isEnabled()
            .then((on) => (on ? true : undefined)),
        );
        yield* press(page.getByTestId("decline"));
        expect(yield* asked(LOCAL, "decline")).toMatchObject({
          proposal: "p-short",
          hash: "h-short",
        });
      }),
    ),
  30_000,
);

test(
  "a working card is held, stopped and steered from its menu",
  () =>
    run(
      Effect.gen(function* () {
        yield* fromMenu("t-work", "Hold run");
        expect(yield* asked(LOCAL, "control")).toMatchObject({
          runId: "r-work",
          control: "hold",
          set: true,
        });
        yield* fromMenu("t-held", "Release hold");
        expect(yield* asked(LOCAL, "control")).toMatchObject({
          runId: "r-held",
          control: "hold",
          set: false,
        });
        yield* fromMenu("t-work", "Stop run");
        expect(yield* asked(LOCAL, "control")).toMatchObject({
          runId: "r-work",
          control: "stop",
          set: true,
        });
        yield* fromMenu("t-work", "Steer…");
        yield* say("Leave the fixtures alone.");
        expect(yield* asked(LOCAL, "steerAbout")).toMatchObject({
          runId: "r-work",
          text: "Leave the fixtures alone.",
          from: null,
          dryRun: false,
        });
      }),
    ),
  30_000,
);

test(
  "Go to pane focuses it on its Machine, attaches a terminal here and says where it is",
  () =>
    run(
      Effect.gen(function* () {
        yield* fromMenu("t-vm", "Go to pane");
        expect(yield* asked(VM, "focus")).toMatchObject({ runId: "r-vm" });
        yield* reads(card("t-vm").getByTestId("pane-where"), "build box › workspace 3 › tab 2");
        const told = yield* settled("the terminal", () =>
          run(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const log = yield* fs
                .readFileString(`${app!.flock}/terminal.log`)
                .pipe(Effect.orElseSucceed(() => ""));
              return log === "" ? undefined : log;
            }),
          ),
        );
        expect(told).toBe("-e herdr --remote mk@vm-mk --session work\n");
      }),
    ),
  30_000,
);

test(
  "a failed card resumes from its first action, and a refusal is said in the host's words",
  () =>
    run(
      Effect.gen(function* () {
        yield* press(card("t-failed").getByTestId("primary"));
        expect(yield* asked(LOCAL, "resume")).toMatchObject({ runId: "r-failed" });
        yield* press(card("t-refused").getByTestId("primary"));
        yield* settled("the refusal", () =>
          app!.page
            .getByText(`resume refused for ${REFUSED_RUN}`)
            .filter({ visible: true })
            .count()
            .then((shown) => (shown > 0 ? true : undefined)),
        );
      }),
    ),
  30_000,
);

test(
  "a finished card takes a follow-up, an offer with what it asks for, and a disposition",
  () =>
    run(
      Effect.gen(function* () {
        const { page } = app!;
        yield* fromMenu("t-done", "Follow-up run");
        yield* say("Seed staging too.");
        expect(yield* asked(LOCAL, "followUp")).toMatchObject({
          runId: "r-done",
          text: "Seed staging too.",
        });

        yield* fromMenu("t-done", "What it offers…");
        yield* press(page.getByTestId("offer-look-again"));
        yield* Effect.promise(() => page.getByTestId("field-note").fill("the seeder again"));
        yield* press(page.getByTestId("invoke"));
        expect(yield* asked(LOCAL, "invoke")).toMatchObject({
          runId: "r-done",
          offer: "look-again",
          input: { note: "the seeder again" },
        });

        yield* fromMenu("t-done", "Mark merged");
        expect(yield* asked(LOCAL, "dispose")).toMatchObject({
          runId: "r-done",
          kind: "merged",
          ref: "collie!151",
        });
      }),
    ),
  30_000,
);

test(
  "a ready plan's first action makes the offer its module declares",
  () =>
    run(
      Effect.gen(function* () {
        yield* reads(card("t-plan").getByTestId("primary"), "Build these tickets");
        yield* press(card("t-plan").getByTestId("primary"));
        expect(yield* asked(LOCAL, "invoke")).toMatchObject({
          runId: "r-plan",
          offer: "build-it",
          input: {},
        });
      }),
    ),
  30_000,
);

test(
  "a new run starts on the Machine chosen, with what the human typed for its inputs",
  () =>
    run(
      Effect.gen(function* () {
        const { page } = app!;
        yield* press(page.getByTestId("new-run"));
        yield* press(page.getByTestId("machine"));
        yield* press(page.getByRole("option", { name: "build box", exact: true }));
        yield* Effect.promise(() => page.getByTestId("project").fill("/home/mk/seeder"));
        yield* press(page.getByTestId("find-workflows"));
        expect(yield* asked(VM, "workflows")).toEqual({ project: "/home/mk/seeder" });
        yield* press(page.getByTestId("workflow-plan"));
        yield* Effect.promise(() => page.getByTestId("input-request").fill("Seed staging nightly"));
        yield* press(page.getByTestId("start"));
        expect(yield* asked(VM, "start")).toMatchObject({
          project: "/home/mk/seeder",
          id: "plan",
          input: {},
          text: { request: "Seed staging nightly" },
        });
      }),
    ),
  30_000,
);
