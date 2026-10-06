// Machines join the Flock from Desktop, in the built app: Add Machine saves one in herdr
// with herdr's question as a dialog, Adopt and Local onboard the same way, a runner is used
// only once its signature verifies, a half-onboarded Machine lists what doctor finds
// missing, and Remove drops a Machine without touching it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Effect, FileSystem } from "effect";
import { signRelease } from "../../src/signing";
import manifest from "../../herdr-plugin.toml";
import { platformOf } from "../src/bun/onboarding";
import { type App, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";

const VERSION: string = manifest.version;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

/**
 * `collie onboard` as a fake runner streams it on the Machine it runs on: its system step
 * needs root until `git-<target>` exists, after which the Machine is onboarded and has a host.
 */
const runner = (flock: string) =>
  new TextEncoder().encode(`#!/bin/sh
on="\${FAKE_TARGET:-local}"
echo "onboard $on $*" >> '${flock}/onboard.log'
echo '{"event":"start","step":"system","title":"Checking for git, curl and openssl"}'
if [ ! -e '${flock}'/"git-$on" ]; then
  echo '{"event":"result","step":"system","status":"needs_root","detail":"git must be installed as root; run the command, then onboard again","command":"sudo apt-get install -y git"}'
  echo '{"ok":false,"error":{"code":"operation_failed","message":"Not onboarded yet","details":{}}}'
  exit 1
fi
echo '{"event":"result","step":"system","status":"in_place","detail":"git, curl and openssl are installed"}'
echo '{"event":"start","step":"doctor","title":"collie doctor"}'
[ "$on" = local ] || printf '{"installation":"%s","herds":[{"id":"default"}],"tasks":[]}' "$on" > '${flock}'/"$on.json"
echo '{"event":"result","step":"doctor","status":"done","detail":"ready"}'
echo '{"ok":true,"data":{"ready":true}}'
`);

let app: App | undefined;
let signed = false;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        const platform = platformOf(yield* Effect.promise(() => Bun.$`uname -sm`.text()));
        const asset = `/${VERSION}/collie-${platform}`;
        let flock = "";
        server = Bun.serve({
          port: 0,
          fetch: (request) => {
            const path = new URL(request.url).pathname;
            const bytes = runner(flock);
            if (path === asset) return new Response(bytes);
            if (path === `${asset}.sig` && signed)
              return new Response(
                signRelease(bytes, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
              );
            return new Response("not here", { status: 404 });
          },
        });
        app = yield* launch(
          [{ label: "bare", target: "mk@bare", session: "default", enabled: true }],
          (dir) =>
            Effect.gen(function* () {
              flock = dir;
              yield* serve(`${dir}/${LOCAL}`, "pc", [], undefined, {
                failing: [
                  { name: "claude login", detail: "not logged in", fix: "claude auth login" },
                ],
              });
            }),
          undefined,
          {
            COLLIE_DESKTOP_RELEASES: `http://127.0.0.1:${server.port}`,
            COLLIE_DESKTOP_RELEASE_KEY: KEY,
          },
        );
      }),
    ),
  120_000,
);

afterAll(() =>
  run(quit(app)).finally(() => {
    void server?.stop(true);
  }),
);

const page = () => app!.page;
const dialog = () => page().getByTestId("onboarding");
const step = (name: string) => dialog().getByTestId(`step-${name}`);
const row = (name: string) => page().getByTestId(`machine-${name}`);
const touch = (name: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(`${app!.flock}/${name}`, ""));
const read = (name: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(`${app!.flock}/${name}`).pipe(Effect.orElseSucceed(() => "")),
  );
const click = (locator: ReturnType<App["page"]["getByTestId"]>) =>
  Effect.promise(() => locator.click());
const closeDialog = Effect.promise(() => page().keyboard.press("Escape"));
const listMachines = Effect.gen(function* () {
  if ((yield* Effect.promise(() => page().getByTestId("add-form").count())) === 0)
    yield* click(page().getByTestId("machines"));
});

test(
  "a live Machine lists what doctor finds missing, though Desktop never onboarded it",
  () =>
    run(
      Effect.gen(function* () {
        yield* listMachines;
        const local = page().locator("[data-testid^=machine-]").first();
        yield* reads(local.getByTestId("step-claude-login").getByTestId("detail"), "not logged in");
        expect(yield* Effect.promise(() => local.getByTestId("login").count())).toBe(1);
        yield* settled("the board in front", () =>
          page()
            .keyboard.press("Escape")
            .then(() => page().getByTestId("add-form").count())
            .then((open) => (open === 0 ? true : undefined)),
        );
      }),
    ),
  60_000,
);

test(
  "a runner without Collie's signature is refused before it reaches the Machine",
  () =>
    run(
      Effect.gen(function* () {
        yield* reads(
          page().getByTestId("lost-bare").locator("[data-slot=title]"),
          "Collie isn't installed on bare",
        );
        yield* click(page().getByTestId("lost-bare").getByRole("button", { name: "Onboard" }));
        yield* reads(
          step("runner").getByTestId("detail"),
          `collie-${platformOf(yield* Effect.promise(() => Bun.$`uname -sm`.text()))} ${VERSION}: the download is unsigned, so it was refused`,
        );
        yield* reads(dialog().getByTestId("outcome"), "Not onboarded yet.");
        expect(yield* read("onboard.log")).toBe("");
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${app!.scratch}/.cache/collie/runners`)).toBe(false);
        yield* closeDialog;
      }),
    ),
  60_000,
);

test(
  "Adopt onboards a herdr machine without Collie; a root step shows its command and Retry, and the Machine lists it as missing until a Retry repairs it",
  () =>
    run(
      Effect.gen(function* () {
        signed = true;
        yield* click(page().getByTestId("lost-bare").getByRole("button", { name: "Onboard" }));
        yield* reads(step("runner").getByTestId("title"), `Collie ${VERSION}'s runner, signed`);
        yield* reads(step("system").getByTestId("command"), "sudo apt-get install -y git");
        expect(yield* Effect.promise(() => step("system").getByTestId("retry").count())).toBe(1);
        yield* closeDialog;

        yield* listMachines;
        yield* reads(row("bare").getByTestId("state"), "Collie isn't installed");
        yield* reads(
          row("bare").getByTestId("step-system").getByTestId("command"),
          "sudo apt-get install -y git",
        );
        yield* touch("git-mk@bare");
        yield* click(row("bare").getByTestId("step-system").getByTestId("retry"));
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        expect(yield* read("onboard.log")).toContain(
          `onboard mk@bare --json onboard --to ${VERSION}`,
        );
        yield* closeDialog;
        yield* listMachines;
        yield* reads(row("bare").getByTestId("state"), "Live");
        yield* reads(row("bare").getByTestId("onboarded"), "Onboarded");
      }),
    ),
  90_000,
);

test(
  "Add Machine saves it in herdr with herdr's question as a dialog that answers No unless told yes, then onboards it",
  () =>
    run(
      Effect.gen(function* () {
        signed = true;
        yield* touch("git-mk@fresh");
        yield* listMachines;
        yield* Effect.promise(() => page().getByTestId("add-target").fill("mk@fresh"));
        yield* Effect.promise(() => page().getByTestId("add-label").fill("fresh"));
        yield* click(page().getByTestId("add-machine"));
        const question = page().getByTestId("herdr-question");
        yield* reads(
          question.getByTestId("question"),
          "The remote server is incompatible. Stop and replace the running server now?",
        );
        // Dismissed, it answers herdr's own default, which for replacing a server is No.
        yield* Effect.promise(() => page().keyboard.press("Escape"));
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        expect(yield* read("herdr.log")).toContain("add mk@fresh replace=n");
        yield* reads(step("herdr").getByTestId("detail"), "herdr machine added-fresh");
        yield* closeDialog;
        yield* listMachines;
        yield* reads(row("fresh").getByTestId("state"), "Live");
      }),
    ),
  90_000,
);

test(
  "Local onboards this computer the same way",
  () =>
    run(
      Effect.gen(function* () {
        yield* touch("git-local");
        yield* listMachines;
        const local = page().locator("[data-testid^=machine-]").first();
        yield* click(local.getByTestId("onboard"));
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        expect(yield* read("onboard.log")).toContain(
          `onboard local --json onboard --to ${VERSION}`,
        );
        yield* closeDialog;
      }),
    ),
  60_000,
);

test(
  "Remove drops a Machine from herdr and its saved board, and stops nothing on it",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const saved = yield* settled("fresh's saved board", () =>
          Bun.$`ls ${app!.scratch}/data/dk.cego.collie.desktop/*/machines/mk%40fresh.json`
            .quiet()
            .nothrow()
            .then((done) => (done.exitCode === 0 ? done.text().trim() : undefined)),
        );
        yield* listMachines;
        yield* click(row("fresh").getByTestId("remove"));
        yield* settled("fresh gone from the list", () =>
          row("fresh")
            .count()
            .then((n) => (n === 0 ? true : undefined)),
        );
        expect(yield* read("herdr.log")).toContain("remove added-fresh");
        expect(yield* fs.exists(saved)).toBe(false);
        // Its host and its board are as they were.
        expect(yield* fs.exists(`${app!.flock}/mk@fresh.json`)).toBe(true);
        expect(yield* read("mk@fresh.json.ops.jsonl")).toBe("");
      }),
    ),
  60_000,
);
