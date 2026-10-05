// A Machine Desktop cannot show live, in the built app: one that drops and comes back,
// one waiting on an SSO login, one without Collie, and a board saved from the last launch.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Clock, Effect, FileSystem } from "effect";
import type { Locator } from "playwright-core";
import { task } from "../../test/support/task";
import { type App, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";

const MACHINES = [
  { label: "vm", target: "mk@vm", session: "default", enabled: true },
  { label: "sso", target: "mk@sso", session: "default", enabled: true },
  { label: "bare", target: "mk@bare", session: "default", enabled: true },
];

let now = 0;
const asking = () =>
  task({
    id: "t-vm",
    name: "Pick a base",
    state: "blocked",
    run: "r-vm",
    at: now,
    decision: {
      kind: "question",
      run: "r-vm",
      id: "q-base",
      step: "plan",
      topic: "base",
      text: "Which base?",
      options: [{ id: "main", title: "main", subtitle: null }],
    },
  });
const signed = () => task({ id: "t-sso", name: "Behind SSO", state: "active", at: now });

let app: App | undefined;

const boards = (flock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* serve(`${flock}/${LOCAL}`, "pc", []);
    yield* serve(`${flock}/mk@vm.json`, "vm", [asking()]);
    yield* serve(`${flock}/mk@sso.json`, "sso", [signed()]);
    yield* fs.writeFileString(`${flock}/sso-mk@sso`, "");
  });

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        now = yield* Clock.currentTimeMillis;
        app = yield* launch(MACHINES, boards);
      }),
    ),
  120_000,
);

afterAll(() => run(quit(app)));

const card = (id: string) => app!.page.getByTestId(`card-${id}`);
const lost = (name: string) => app!.page.getByTestId(`lost-${name}`);
const touch = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${app!.flock}/${name}`, "");
  });
const remove = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(`${app!.flock}/${name}`);
  });
const count = (locator: Locator) => Effect.promise(() => locator.count());
const disabled = (locator: Locator) => Effect.promise(() => locator.isDisabled());
const asOf = (id: string) =>
  settled(`${id} marked as of a time`, () =>
    card(id)
      .getByTestId("as-of")
      .textContent({ timeout: 1000 })
      .then((text) => (/^as of \d\d:\d\d$/.test(text?.trim() ?? "") ? true : undefined))
      .catch(() => undefined),
  );
const live = (id: string) =>
  settled(`${id} live`, () =>
    Promise.all([card(id).count(), card(id).getByTestId("as-of").count()]).then(([shown, stale]) =>
      shown === 1 && stale === 0 ? true : undefined,
    ),
  );

test(
  "a Machine waiting on an SSO login says so, and shows its board once the login clears",
  () =>
    run(
      Effect.gen(function* () {
        yield* reads(lost("sso").locator("[data-slot=title]"), "Waiting for SSO login on sso");
        yield* remove("sso-mk@sso");
        yield* reads(card("t-sso").getByTestId("name"), "Behind SSO");
        expect(yield* count(lost("sso"))).toBe(0);
      }),
    ),
  30_000,
);

test(
  "a reachable Machine without Collie says so with Onboard, and becomes its Machine once it has one",
  () =>
    run(
      Effect.gen(function* () {
        yield* reads(lost("bare").locator("[data-slot=title]"), "Collie isn't installed on bare");
        expect(yield* count(lost("bare").getByRole("button", { name: "Onboard" }))).toBe(1);
        yield* serve(`${app!.flock}/mk@bare.json`, "bare", [
          task({ id: "t-bare", name: "Fresh install", state: "active", at: now }),
        ]);
        yield* reads(card("t-bare").getByTestId("name"), "Fresh install");
        expect(yield* count(lost("bare"))).toBe(0);
      }),
    ),
  60_000,
);

test(
  "a Machine that drops keeps its cards dimmed as of when, with actions off, and comes back by itself",
  () =>
    run(
      Effect.gen(function* () {
        yield* reads(card("t-vm").getByTestId("name"), "Pick a base");
        yield* touch("down-mk@vm");
        yield* asOf("t-vm");
        yield* reads(
          lost("vm").locator("[data-slot=description]"),
          "ssh: connect to host vm port 22: Connection refused",
        );
        expect(yield* disabled(card("t-vm").getByTestId("option-main"))).toBe(true);
        expect(yield* disabled(card("t-vm").getByTestId("menu"))).toBe(true);
        yield* remove("down-mk@vm");
        yield* live("t-vm");
        expect(yield* disabled(card("t-vm").getByTestId("option-main"))).toBe(false);
        expect(yield* count(lost("vm"))).toBe(0);
      }),
    ),
  60_000,
);

test(
  "at launch the boards saved last time show dimmed until each connection is live",
  () =>
    run(
      Effect.gen(function* () {
        // Saved as the board stood when the app quit.
        yield* reads(card("t-vm").getByTestId("name"), "Pick a base");
        yield* quit(app);
        const scratch = app!.scratch;
        app = undefined;
        app = yield* launch(
          MACHINES,
          (flock) =>
            Effect.gen(function* () {
              yield* boards(flock);
              const fs = yield* FileSystem.FileSystem;
              yield* fs.writeFileString(`${flock}/down-mk@vm`, "");
            }),
          scratch,
        );
        yield* reads(card("t-vm").getByTestId("name"), "Pick a base");
        yield* asOf("t-vm");
        yield* remove("down-mk@vm");
        yield* live("t-vm");
      }),
    ),
  120_000,
);
