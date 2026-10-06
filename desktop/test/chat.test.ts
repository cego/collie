// The Flock chat's markdown, which an agent wrote, as the window shows a conversation read back.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { DESKTOP_SAID } from "../src/shared/chat-view";
import { type App, LOCAL, launch, quit, run, serve, settled } from "./support/app";

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const SESSION = "11111111-1111-4111-8111-111111111111";
const HOSTILE = [
  '<img src="x" onerror="window.pwned = true">',
  "",
  '<div style="position:fixed;inset:0">over all</div>',
  "",
  "See [the dashboard](https://kibana.cego.dk/app/dash/1).",
].join("\n");

/** A transcript where Claude Code keeps it for Desktop's own directory. */
const transcript = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const own = `${home}/.local/state/collie-desktop`;
    const projects = `${home}/.claude/projects/${own.replace(/[^a-zA-Z0-9]/g, "-")}`;
    yield* fs.makeDirectory(projects, { recursive: true });
    yield* fs.makeDirectory(own, { recursive: true });
    yield* fs.writeFileString(`${own}/flock-chat.json`, asJson({ session: SESSION }));
    const entry = (
      uuid: string,
      parent: string | null,
      type: "user" | "assistant",
      content: string | ReadonlyArray<{ type: "text"; text: string }>,
    ) =>
      asJson({
        type,
        uuid,
        parentUuid: parent,
        sessionId: SESSION,
        parent_tool_use_id: null,
        isSidechain: false,
        message: { role: type, content },
        timestamp: "2026-10-06T00:00:00Z",
        cwd: own,
      });
    yield* fs.writeFileString(
      `${projects}/${SESSION}.jsonl`,
      [
        entry("u1", null, "user", `${DESKTOP_SAID}\n\n${HOSTILE}`),
        entry("a1", "u1", "assistant", [{ type: "text", text: HOSTILE }]),
      ].join("\n"),
    );
  });

let app: App | undefined;

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        app = yield* launch(
          [],
          (flock) =>
            serve(`${flock}/${LOCAL}`, "pc", []).pipe(
              Effect.andThen(transcript(flock.replace(/\/flock$/, ""))),
            ),
          { browsers: true },
        );
      }),
    ),
  120_000,
);

afterAll(() => run(quit(app)));

test(
  "the chat keeps none of an agent's handlers or styles, and a web link opens in the browser",
  () =>
    run(
      Effect.gen(function* () {
        const page = app!.page;
        for (const testId of ["chat-desktop", "chat-assistant"]) {
          const said = page.getByTestId(testId);
          yield* settled(`the ${testId} message`, () =>
            said
              .getByText("over all")
              .count()
              .then((n) => n || undefined),
          );
          expect(yield* Effect.promise(() => said.locator("[onerror]").count())).toBe(0);
          expect(yield* Effect.promise(() => said.locator("[style*='fixed']").count())).toBe(0);
        }
        expect(yield* Effect.promise(() => page.evaluate(() => "pwned" in window))).toBe(false);
        yield* Effect.promise(() =>
          page.getByTestId("chat-assistant").getByRole("link", { name: "the dashboard" }).click(),
        );
        const log = yield* settled("the browser asked", () =>
          Bun.file(`${app!.flock}/opened.log`)
            .text()
            .catch(() => "")
            .then((text) => text || undefined),
        );
        expect(log.trim()).toBe("https://kibana.cego.dk/app/dash/1");
      }),
    ),
  30_000,
);
