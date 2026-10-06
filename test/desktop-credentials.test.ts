// What only the human can give, asked once by Desktop: the GitLab token and Helle's
// token kept in an owner-only file and handed to every Machine on stdin, and the logins
// finished in this computer's browser through a forwarded callback port.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Queue, type Scope } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { signRelease } from "../src/signing";
import { epochMs } from "../src/time";
import { localRoute, type ShellRoute } from "../desktop/src/bun/machine";
import { onboardThrough, platformOf } from "../desktop/src/bun/onboarding";
import {
  claudeLoginThrough,
  giveHelle,
  giveToken,
  gitlabToken,
  helleOwner,
  credentialsFile,
  secretsFor,
} from "../desktop/src/bun/credentials";
import { type OnboardRun } from "../desktop/src/shared/flock";
import { renewalDue } from "../src/gitlab-token";
import { HELLE_URL } from "../src/helle-url";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

const scratch = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "collie-credentials-" }),
);

const executable = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, text);
    yield* fs.chmod(path, 0o755);
  });

/** A Machine reached as Local is, in a home of the test's own with `bin` first on PATH. */
const machineIn = (home: string, bin: string, forwarded: number[] = []): ShellRoute => ({
  ...localRoute([], "pc"),
  sh: (script) =>
    Effect.succeed([
      "/usr/bin/env",
      `HOME=${home}`,
      `PATH=${bin}:${Bun.env.PATH}`,
      "/bin/sh",
      "-c",
      script,
    ]),
  forward: (port) => Effect.sync(() => void forwarded.push(port)),
});

/** `secret-tool`, as an earlier Desktop kept its secrets: each in a file named for its attributes. */
const fakeSecretTool = (dir: string) =>
  executable(
    `${dir}/secret-tool`,
    `#!/bin/sh
[ "$1" = lookup ] && shift && cat "${dir}/secret-$(echo "$@" | tr ' /' '__')"
`,
  );

test("a secret is kept in an owner-only file and read back, with no secret-tool anywhere", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${yield* scratch}/collie-desktop`;
      const keyring = credentialsFile(dir, `${dir}/no-such-tool`);
      expect(yield* keyring.lookup("gitlab-token")).toBeNull();
      // Nothing to copy is not written down, so a keyring that did not answer is asked again.
      expect(yield* fs.exists(`${dir}/credentials`)).toBe(false);
      yield* keyring.store("gitlab-token", "Collie's GitLab token", "glpat-123");
      yield* keyring.store("helle-token", "Collie's Helle token", "h-1");
      expect(yield* keyring.lookup("gitlab-token")).toBe("glpat-123");
      expect(yield* credentialsFile(dir).lookup("helle-token")).toBe("h-1");
      expect(((yield* fs.stat(dir)).mode & 0o777).toString(8)).toBe("700");
      expect(((yield* fs.stat(`${dir}/credentials`)).mode & 0o777).toString(8)).toBe("600");
      expect(yield* fs.exists(`${dir}/credentials.new`)).toBe(false);
    }),
  ));

test("what an earlier Desktop kept through secret-tool is moved into the file, once", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      yield* fakeSecretTool(dir);
      yield* fs.writeFileString(
        `${dir}/secret-service_collie-desktop_key_gitlab-token`,
        "glpat-old",
      );
      const keyring = credentialsFile(`${dir}/collie-desktop`, `${dir}/secret-tool`);
      expect(yield* keyring.lookup("gitlab-token")).toBe("glpat-old");
      expect(yield* keyring.lookup("helle-token")).toBeNull();
      // The file is what is read from now on, with or without secret-tool.
      yield* fs.writeFileString(`${dir}/secret-service_collie-desktop_key_helle-token`, "h-late");
      const later = credentialsFile(`${dir}/collie-desktop`, `${dir}/no-such-tool`);
      expect(yield* later.lookup("gitlab-token")).toBe("glpat-old");
      expect(yield* later.lookup("helle-token")).toBeNull();
    }),
  ));

/** GitLab, answering `personal_access_tokens/self` for `glpat-good` and refusing the rest. */
const gitlab = (scopes: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch: (request) =>
          new URL(request.url).pathname === "/api/v4/personal_access_tokens/self" &&
          request.headers.get("PRIVATE-TOKEN") === "glpat-good"
            ? Response.json({ expires_at: "2026-12-01", scopes })
            : new Response("401 Unauthorized", { status: 401 }),
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  );

test("a GitLab token is taken only once GitLab accepts it with the scopes Collie needs, and its expiry is read", () =>
  run(
    Effect.gen(function* () {
      const good = yield* gitlab(["api", "write_repository"]);
      const base = `http://127.0.0.1:${good.port}`;
      expect(yield* gitlabToken(base, "glpat-good")).toEqual({ expires: "2026-12-01" });
      expect(yield* gitlabToken(base, "glpat-bad").pipe(Effect.flip)).toContain("did not accept");
      const narrow = yield* gitlab(["read_api"]);
      expect(
        yield* gitlabToken(`http://127.0.0.1:${narrow.port}`, "glpat-good").pipe(Effect.flip),
      ).toContain("api and write_repository");
    }),
  ));

/** Helle, answering `/me` for `h-1` and refusing the rest. */
const helle = Effect.acquireRelease(
  Effect.sync(() =>
    Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname !== "/api/v1/me"
          ? new Response("", { status: 404 })
          : request.headers.get("Authorization") === "Bearer h-1"
            ? Response.json({ user_id: "u-1", display_name: "mk" })
            : Response.json({ detail: "invalid token" }, { status: 401 }),
    }),
  ),
  (server) => Effect.sync(() => void server.stop(true)),
);

test("a Helle token is checked against Helle's /me, which says whose it is or refuses it", () =>
  run(
    Effect.gen(function* () {
      const base = `http://127.0.0.1:${(yield* helle).port}`;
      expect(yield* helleOwner(base, "h-1")).toBe("mk");
      expect(yield* helleOwner(base, "h-bad").pipe(Effect.flip)).toBe(
        "Helle refused that token; make a new one with /helle token",
      );
      expect(yield* helleOwner("http://127.0.0.1:1", "h-1").pipe(Effect.flip)).toContain(
        "could not ask Helle",
      );
    }),
  ));

test("a token is due for renewal from 14 days before it expires", () => {
  const now = epochMs("2026-11-01T12:00:00Z");
  expect(renewalDue("2026-11-16", now)).toBe(false);
  expect(renewalDue("2026-11-14", now)).toBe(true);
  expect(renewalDue("2026-10-30", now)).toBe(true);
  expect(renewalDue(null, now)).toBe(false);
});

test("the secrets Desktop holds are handed to collie onboard as stdin lines", () =>
  run(
    Effect.gen(function* () {
      const dir = yield* scratch;
      const keyring = credentialsFile(dir, `${dir}/no-such-tool`);
      expect(yield* secretsFor(keyring)).toBe("");
      yield* keyring.store("gitlab-token", "token", "glpat-good");
      yield* keyring.store("helle-token", "token", "h-1");
      expect(yield* secretsFor(keyring)).toBe("GITLAB_TOKEN=glpat-good\nHELLE_API_TOKEN=h-1\n");
    }),
  ));

/** A runner of 0.40.0 that logs its arguments and stdin, then asks for Linear's login. */
const RUNNER = (dir: string) => `#!/bin/sh
echo "$*" > '${dir}/args'
cat > '${dir}/stdin'
echo '{"event":"start","step":"linear","title":"The Linear MCP in Claude Code"}'
echo '{"event":"human","step":"linear","detail":"open this to let Claude Code reach Linear","url":"https://mcp.linear.app/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A62074%2Fcallback","port":62074}'
echo '{"event":"result","step":"linear","status":"done","detail":"logged in to Linear"}'
echo '{"ok":true,"data":{"ready":true}}'
`;

test("onboarding gives the runner Desktop's secrets on stdin, and forwards and opens a login it streams", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const home = `${dir}/home`;
      yield* fs.makeDirectory(home);
      const key = generateKeyPairSync("ed25519");
      const bytes = new TextEncoder().encode(RUNNER(dir));
      const platform = platformOf(yield* Effect.promise(() => Bun.$`uname -sm`.text()));
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch: (request) => {
              const path = new URL(request.url).pathname;
              if (path === `/0.40.0/collie-${platform}`) return new Response(bytes);
              if (path === `/0.40.0/collie-${platform}.sig`)
                return new Response(
                  signRelease(
                    bytes,
                    key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
                  ),
                );
              return new Response("no", { status: 404 });
            },
          }),
        ),
        (one) => Effect.promise(() => one.stop(true)),
      );
      const forwarded: number[] = [];
      const opened: string[] = [];
      const last = yield* onboardThrough(
        machineIn(home, dir, forwarded),
        {
          version: "0.40.0",
          releases: `http://127.0.0.1:${server.port}`,
          runners: `${dir}/runners`,
          key: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
          secrets: "GITLAB_TOKEN=glpat-good\n",
          open: (url) => Effect.sync(() => void opened.push(url)),
        },
        () => Effect.void,
      );
      expect(last.ready).toBe(true);
      expect((yield* fs.readFileString(`${dir}/args`)).trim()).toBe(
        "--json onboard --to 0.40.0 --secrets-stdin",
      );
      expect(yield* fs.readFileString(`${dir}/stdin`)).toBe("GITLAB_TOKEN=glpat-good\n");
      expect(forwarded).toEqual([62074]);
      expect(opened).toEqual([
        "https://mcp.linear.app/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A62074%2Fcallback",
      ]);
    }),
  ));

/**
 * `claude auth login` as Claude Code 2.1 does it: the URL with its callback port goes to
 * `$BROWSER`, only the paste-code URL is printed, and the login ends at a callback with a
 * code or at a pasted code. How it ended is written to `<dir>/login`.
 */
const fakeClaude = (dir: string) =>
  executable(
    `${dir}/claude`,
    `#!${process.execPath}
const done = (how) => { require("fs").writeFileSync("${dir}/login", how); process.exit(0); };
const server = Bun.serve({ port: 0, fetch: (request) => {
  const code = new URL(request.url).searchParams.get("code");
  if (code === null) return new Response("bad", { status: 400 });
  setTimeout(() => done("browser " + code), 10);
  return new Response("ok");
} });
const callback = encodeURIComponent("http://localhost:" + server.port + "/callback");
Bun.spawn([process.env.BROWSER, "https://claude.example/oauth/authorize?redirect_uri=" + callback]);
console.log("Browser didn't open? Use the url below to sign in:");
console.log("https://claude.example/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback");
process.stdout.write("Paste code here if prompted > ");
for await (const line of console) done("code " + line.trim());
`,
  );

const loginRun: OnboardRun = { steps: [], asked: null, ready: null, reason: null, at: 0 };

test("the Claude login finishes by approving in this computer's browser through its forwarded callback port", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const home = `${dir}/home`;
      yield* fs.makeDirectory(home);
      yield* fakeClaude(dir);
      const forwarded: number[] = [];
      const runs: OnboardRun[] = [];
      const codes = yield* Queue.unbounded<string>();
      // This computer's browser, approving the login at the callback it was sent to.
      const browser = (url: string) => {
        const callback = new URL(new URL(url).searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "c-1");
        return HttpClient.get(callback.href).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.ignore,
        );
      };
      const ended = yield* claudeLoginThrough(
        machineIn(home, dir, forwarded),
        browser,
        codes,
        (now) => Effect.sync(() => void runs.push(now)),
        loginRun,
      );
      expect(ended.ended).toBe(true);
      expect(yield* fs.readFileString(`${dir}/login`)).toBe("browser c-1");
      expect(forwarded).toHaveLength(1);
      // The paste-code URL is offered while the login waits, as the fallback.
      expect(runs.some(({ steps }) => steps[0]?.url?.includes("platform.claude.com"))).toBe(true);
    }),
  ));

test("the Claude login takes a pasted code where the browser cannot reach its callback", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const home = `${dir}/home`;
      yield* fs.makeDirectory(home);
      yield* fakeClaude(dir);
      const codes = yield* Queue.unbounded<string>();
      yield* Queue.offer(codes, "pasted-1");
      const ended = yield* claudeLoginThrough(
        machineIn(home, dir),
        () => Effect.void,
        codes,
        () => Effect.void,
        loginRun,
      );
      expect(ended.ended).toBe(true);
      expect(yield* fs.readFileString(`${dir}/login`)).toBe("code pasted-1");
    }),
  ));

test("the GitLab token is given to glab on every Machine on stdin, and each says how it went", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      yield* fs.makeDirectory(`${dir}/home`);
      yield* executable(
        `${dir}/glab`,
        `#!/bin/sh
echo "$* $(cat)" >> '${dir}/glab.log'
`,
      );
      const vm = { ...machineIn(`${dir}/home`, dir), machine: { profile: "p-vm", name: "vm" } };
      const down: ShellRoute = {
        ...vm,
        machine: { profile: "p-down", name: "down" },
        sh: () => Effect.fail("ssh: connection refused"),
      };
      const said = yield* giveToken([vm, down], "gitlab.example", "glpat-new");
      expect(said).toEqual([
        { name: "vm", failed: null },
        { name: "down", failed: "ssh: connection refused" },
      ]);
      expect((yield* fs.readFileString(`${dir}/glab.log`)).trim()).toBe(
        "auth login --hostname gitlab.example --stdin glpat-new",
      );
    }),
  ));

test("Helle's credentials are written on every Machine, readable by its owner alone", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      yield* fs.makeDirectory(`${dir}/home`);
      const said = yield* giveHelle([machineIn(`${dir}/home`, dir)], HELLE_URL, "h-1");
      expect(said).toEqual([{ name: "pc", failed: null }]);
      const file = `${dir}/home/.config/helle/env`;
      expect(yield* fs.readFileString(file)).toBe(
        "HELLE_API_URL=https://helle.cego.dk\nHELLE_API_TOKEN=h-1\n",
      );
      expect(((yield* fs.stat(file)).mode & 0o777).toString(8)).toBe("600");
    }),
  ));
