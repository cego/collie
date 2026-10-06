// What only the human can give, asked once by Desktop, in the built app: the GitLab token
// made on GitLab's own page and Helle's token, kept in Desktop's own file and given to every
// Machine; the Claude login finished in this computer's browser through a forwarded port,
// or with a pasted code; Linear's login through its forwarded port; and the token renewed
// on every Machine before it expires.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { DateTime, Effect, FileSystem } from "effect";
import { signRelease } from "../../src/signing";
import manifest from "../../herdr-plugin.toml";
import { platformOf } from "../src/bun/onboarding";
import { type App, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";

const VERSION: string = manifest.version;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const LINEAR =
  "https://mcp.linear.app/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A62074%2Fcallback";

/**
 * `collie onboard` as it goes with the secrets it is given on stdin, which it logs: Claude
 * Code is logged in once `claude-<target>` exists, glab once it has a token, Helle once it
 * has hers, and Linear's login streams its URL and port.
 */
const runner = (flock: string) =>
  new TextEncoder().encode(`#!/bin/sh
on="\${FAKE_TARGET:-local}"
secrets=""
[ "$5" = --secrets-stdin ] && secrets=$(cat)
printf '%s\\n' "$secrets" > '${flock}'/"stdin-$on"
echo "$*" > '${flock}'/"args-$on"
ready=true
start() { echo "{\\"event\\":\\"start\\",\\"step\\":\\"$1\\",\\"title\\":\\"$2\\"}"; }
done_() { echo "{\\"event\\":\\"result\\",\\"step\\":\\"$1\\",\\"status\\":\\"done\\",\\"detail\\":\\"$2\\"}"; }
start claude-login "Claude Code logged in"
if [ -e '${flock}'/"claude-$on" ]; then done_ claude-login "logged in"; else
  echo '{"event":"result","step":"claude-login","status":"needs_human","detail":"log in to Claude Code on this Machine","command":"claude auth login"}'; ready=false; fi
start gitlab "Logged in to gitlab"
case "$secrets" in *GITLAB_TOKEN=*) done_ gitlab "glab is logged in" ;; *)
  echo '{"event":"result","step":"gitlab","status":"needs_human","detail":"make a token with the api and write_repository scopes","url":"https://gitlab.example/-/user_settings/personal_access_tokens?name=collie&scopes=api,write_repository"}'; ready=false ;; esac
start helle "Helle's credentials"
case "$secrets" in *HELLE_API_TOKEN=*) done_ helle "wrote it" ;; *)
  echo '{"event":"result","step":"helle","status":"needs_human","detail":"give HELLE_API_TOKEN"}'; ready=false ;; esac
start linear "The Linear MCP in Claude Code"
case " $* " in *" --skip linear "*)
  echo '{"event":"result","step":"linear","status":"skipped","detail":"skipped for this Machine"}' ;; *)
  echo '{"event":"human","step":"linear","detail":"open this to let Claude Code reach Linear","url":"${LINEAR}","port":62074}'
  if [ -e '${flock}/linear-fails' ]; then
    echo '{"event":"result","step":"linear","status":"failed","detail":"the Linear login did not finish"}'; ready=false
  else done_ linear "logged in to Linear"; fi ;; esac
if $ready; then echo '{"ok":true,"data":{"ready":true}}'; else
  echo '{"ok":false,"error":{"code":"operation_failed","message":"Not onboarded yet","details":{}}}'; exit 1; fi
`);

let app: App | undefined;
let releases: ReturnType<typeof Bun.serve> | undefined;
let gitlab: ReturnType<typeof Bun.serve> | undefined;
let helle: ReturnType<typeof Bun.serve> | undefined;
const day = (from: number) =>
  DateTime.formatIsoDate(DateTime.add(DateTime.nowUnsafe(), { days: from }));
/** How soon each token GitLab knows expires: the first is due for renewal. */
const EXPIRES = new Map([
  ["glpat-good", day(5)],
  ["glpat-new", day(90)],
]);

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        const platform = platformOf(yield* Effect.promise(() => Bun.$`uname -sm`.text()));
        const asset = `/${VERSION}/collie-${platform}`;
        let flock = "";
        releases = Bun.serve({
          port: 0,
          fetch: (request) => {
            const path = new URL(request.url).pathname;
            const bytes = runner(flock);
            if (path === asset) return new Response(bytes);
            if (path === `${asset}.sig`)
              return new Response(
                signRelease(bytes, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
              );
            return new Response("not here", { status: 404 });
          },
        });
        gitlab = Bun.serve({
          port: 0,
          fetch: (request) => {
            const expires = EXPIRES.get(request.headers.get("PRIVATE-TOKEN") ?? "");
            return expires === undefined
              ? new Response("401 Unauthorized", { status: 401 })
              : Response.json({ expires_at: expires, scopes: ["api", "write_repository"] });
          },
        });
        helle = Bun.serve({
          port: 0,
          fetch: (request) =>
            request.headers.get("Authorization") === "Bearer h-1"
              ? Response.json({ user_id: "u-1", display_name: "mk" })
              : Response.json({ detail: "invalid token" }, { status: 401 }),
        });
        app = yield* launch(
          ["a", "b", "c", "d"].map((name) => ({
            label: name,
            target: `mk@${name}`,
            session: "default",
            enabled: true,
          })),
          (dir) =>
            Effect.gen(function* () {
              flock = dir;
              yield* serve(`${dir}/${LOCAL}`, "pc", []);
            }),
          {
            env: {
              COLLIE_DESKTOP_RELEASES: `http://127.0.0.1:${releases.port}`,
              COLLIE_DESKTOP_RELEASE_KEY: publicKey
                .export({ type: "spki", format: "pem" })
                .toString(),
              COLLIE_DESKTOP_GITLAB: `http://127.0.0.1:${gitlab.port}`,
              COLLIE_HELLE_URL: `http://127.0.0.1:${helle.port}`,
            },
          },
        );
      }),
    ),
  120_000,
);

afterAll(() =>
  run(quit(app)).finally(() => {
    void releases?.stop(true);
    void gitlab?.stop(true);
    void helle?.stop(true);
  }),
);

const page = () => app!.page;
const dialog = () => page().getByTestId("onboarding");
const step = (name: string) => dialog().getByTestId(`step-${name}`);
const row = (name: string) => page().getByTestId(`machine-${name}`);
const press = (locator: ReturnType<App["page"]["getByTestId"]>) =>
  Effect.promise(() => locator.click());
const fill = (locator: ReturnType<App["page"]["getByTestId"]>, text: string) =>
  Effect.promise(() => locator.fill(text));
const touch = (name: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(`${app!.flock}/${name}`, ""));
const read = (name: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(`${app!.flock}/${name}`).pipe(Effect.orElseSucceed(() => "")),
  );
const holds = (name: string, text: string) =>
  settled(`${name} holding "${text}"`, () =>
    Bun.file(`${app!.flock}/${name}`)
      .text()
      .then((now) => (now.includes(text) ? true : undefined))
      .catch(() => undefined),
  );
const closeDialog = Effect.promise(() => page().keyboard.press("Escape"));
const listMachines = Effect.gen(function* () {
  if ((yield* Effect.promise(() => page().getByTestId("add-form").count())) === 0)
    yield* press(page().getByTestId("machines"));
});
const onboardOn = (name: string) =>
  Effect.gen(function* () {
    yield* listMachines;
    yield* press(row(name).getByTestId("onboard"));
  });

test(
  "the GitLab token is made on GitLab's own page and Helle's given once, kept in Desktop's credentials file, and a second Machine needs neither",
  () =>
    run(
      Effect.gen(function* () {
        yield* touch("claude-mk@a");
        yield* touch("claude-mk@b");
        yield* listMachines;
        yield* press(page().getByTestId("token-page"));
        yield* holds(
          "opened.log",
          "/-/user_settings/personal_access_tokens?name=collie&scopes=api,write_repository",
        );

        yield* onboardOn("a");
        yield* fill(step("gitlab").getByTestId("gitlab-token"), "glpat-good");
        yield* press(step("gitlab").getByTestId("save-gitlab"));
        // Onboarded again, with the token.
        yield* reads(step("gitlab").getByTestId("detail"), "glab is logged in");
        // Helle makes tokens in Slack: its app where it opens, its web client otherwise.
        yield* press(step("helle").getByTestId("helle-slack"));
        yield* holds("opened.log", "slack://open");
        yield* touch("no-slack");
        yield* press(step("helle").getByTestId("helle-slack"));
        yield* holds("opened.log", "https://app.slack.com/client");
        yield* press(step("helle").getByTestId("helle-copy"));
        yield* reads(
          page().getByText("Copied /helle token", { exact: true }),
          "Copied /helle token",
        );
        // A token Helle refuses is said, and cannot be saved.
        yield* fill(step("helle").getByTestId("helle-token"), "h-bad");
        yield* reads(
          step("helle").getByTestId("helle-check"),
          "Helle refused that token; make a new one with /helle token",
        );
        expect(
          yield* Effect.promise(() => step("helle").getByTestId("save-helle").isDisabled()),
        ).toBe(true);
        yield* fill(step("helle").getByTestId("helle-token"), "h-1");
        yield* reads(step("helle").getByTestId("helle-check"), "Belongs to mk");
        yield* press(step("helle").getByTestId("save-helle"));
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        expect(
          yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) =>
              fs.readFileString(`${app!.scratch}/.config/collie-desktop/credentials`),
            ),
          ),
        ).toContain("gitlab-token=glpat-good\n");
        expect(yield* read("stdin-mk@a")).toContain("GITLAB_TOKEN=glpat-good");
        // The token went to glab on every Machine Desktop reaches, on stdin.
        yield* holds("glab.log", "mk@b auth login --hostname");
        expect(yield* read("glab.log")).toContain("--stdin glpat-good");
        yield* closeDialog;

        yield* onboardOn("b");
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        expect(yield* read("stdin-mk@b")).toBe("GITLAB_TOKEN=glpat-good\nHELLE_API_TOKEN=h-1\n");
        yield* closeDialog;
      }),
    ),
  120_000,
);

test(
  "the Linear MCP's login is forwarded from its Machine and opened in this computer's browser",
  () =>
    run(
      Effect.gen(function* () {
        yield* holds("ssh.log", "forward 62074:127.0.0.1:62074 mk@a");
        yield* holds("opened.log", LINEAR);
      }),
    ),
  30_000,
);

test(
  "the Claude login on a remote Machine finishes by approving in this computer's browser",
  () =>
    run(
      Effect.gen(function* () {
        yield* onboardOn("c");
        yield* press(step("claude-login").getByTestId("login"));
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        expect(yield* read("claude-mk@c")).toBe("browser c-1");
        expect(yield* read("ssh.log")).toMatch(/forward (\d+):127\.0\.0\.1:\1 mk@c/);
        yield* closeDialog;
      }),
    ),
  90_000,
);

test(
  "the Claude login takes a pasted code where the browser cannot reach its callback",
  () =>
    run(
      Effect.gen(function* () {
        yield* touch("no-browser");
        yield* onboardOn("d");
        yield* press(step("claude-login").getByTestId("login"));
        yield* fill(step("claude-login").getByTestId("code"), "pasted-1");
        yield* press(step("claude-login").getByTestId("send-code"));
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        expect(yield* read("claude-mk@d")).toBe("code pasted-1");
        yield* closeDialog;
      }),
    ),
  90_000,
);

test(
  "a token due within 14 days is warned of, and Renew gives the new one to every Machine",
  () =>
    run(
      Effect.gen(function* () {
        // The board, with nothing open over it.
        yield* settled("the board in front", () =>
          page()
            .keyboard.press("Escape")
            .then(() => page().getByTestId("add-form").count())
            .then((open) => (open === 0 ? true : undefined)),
        );
        yield* reads(
          page().getByTestId("renew-gitlab").locator("[data-slot=title]"),
          `The GitLab token expires on ${EXPIRES.get("glpat-good")}`,
        );
        yield* press(page().getByTestId("renew-gitlab").getByRole("button", { name: "Renew" }));
        yield* fill(page().getByTestId("credentials").getByTestId("gitlab-token"), "glpat-new");
        yield* press(page().getByTestId("credentials").getByTestId("save-gitlab"));
        for (const name of ["a", "b", "c", "d"])
          yield* holds(
            "glab.log",
            `mk@${name} auth login --hostname 127.0.0.1:${gitlab!.port} --stdin glpat-new`,
          );
        yield* reads(page().getByTestId("gitlab-state"), `expires ${EXPIRES.get("glpat-new")}`);
        expect(yield* Effect.promise(() => page().getByTestId("renew-gitlab").count())).toBe(0);
      }),
    ),
  60_000,
);

test(
  "Linear's step left failed can be skipped on that Machine, and stays skipped when it is onboarded again",
  () =>
    run(
      Effect.gen(function* () {
        yield* touch("linear-fails");
        yield* onboardOn("a");
        yield* reads(step("linear").getByTestId("detail"), "the Linear login did not finish");
        yield* press(step("linear").getByTestId("skip"));
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        expect(yield* read("args-mk@a")).toContain("--skip linear");
        yield* closeDialog;
        yield* onboardOn("a");
        yield* reads(dialog().getByTestId("outcome"), "Onboarded: collie doctor is ready.");
        yield* reads(step("linear").getByTestId("detail"), "skipped for this Machine");
        yield* closeDialog;
      }),
    ),
  90_000,
);
