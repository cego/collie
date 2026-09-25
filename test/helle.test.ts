// Helle as Collie's own client, and the gate a Step declares with `waits: helle`.
// Everything runs against a stand-in server this test controls, because the states
// that matter — someone else holding the project, a queue that moves, a 500 — are
// exactly the ones a real Helle will not produce on demand.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Path, Result } from "effect";
import { runEffect } from "./support/effect";
import {
  credentials,
  helleProjects,
  releaseClaim,
  resolveProject,
  waitForHelle,
  type HelleClaim,
  type HelleProject,
} from "../src/helle";
import { controlPath, handOverClaim } from "../src/engine";

const ME = "6b9ba520-user";
const OTHER = "2dd236ac-other";

/** One project as Helle reports it, holder and queue included. */
interface Fake {
  projects: {
    slug: string;
    group?: string;
    holder?: { user_id: string; display_name: string };
    queue: { user_id: string }[];
  }[];
  /** Status to answer `GET /projects` with, for the failures that are refusals. */
  listStatus: number;
  meStatus: number;
  /** What a claim answers, in the order claims arrive. */
  claims: { position: number; already_queued: boolean }[];
  calls: string[];
}
let fake: Fake;
let server: { base: string; stop: () => void };

function serve() {
  const listening = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      fake.calls.push(`${request.method} ${url.pathname}`);
      if (request.headers.get("authorization") !== "Bearer token-abc") {
        return Response.json({ detail: "unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/api/v1/me") {
        return fake.meStatus === 200
          ? Response.json({ user_id: ME, display_name: "mk" })
          : Response.json({ detail: "no" }, { status: fake.meStatus });
      }
      if (url.pathname === "/api/v1/projects") {
        return fake.listStatus === 200
          ? Response.json(fake.projects)
          : Response.json({ detail: "no" }, { status: fake.listStatus });
      }
      const one = /^\/api\/v1\/projects\/([^/]+)(\/claim|\/release)?$/.exec(url.pathname);
      const project = one ? fake.projects.find((p) => p.slug === one[1]) : undefined;
      if (!one || !project) return Response.json({ detail: "not found" }, { status: 404 });
      if (one[2] === "/claim") {
        const answer = fake.claims.shift() ?? { position: 0, already_queued: false };
        if (answer.position === 0) project.holder = { user_id: ME, display_name: "mk" };
        return Response.json(answer);
      }
      if (one[2] === "/release") {
        delete project.holder;
        return Response.json({ released: true });
      }
      return Response.json(project);
    },
  });
  return {
    base: `http://127.0.0.1:${listening.port}`,
    stop: () => void listening.stop(true),
  };
}

beforeEach(() => {
  fake = { projects: [], listStatus: 200, meStatus: 200, claims: [], calls: [] };
  server = serve();
});
afterEach(() => server.stop());

/** An env file in the shape the MCP wrapper's own one has. */
const envFile = Effect.fn("test.envFile")(function* (token = "token-abc", url = server.base) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectory();
  const file = path.join(dir, "env");
  yield* fs.writeFileString(
    file,
    `# helle\nexport HELLE_API_URL=${url}\nHELLE_API_TOKEN=${token}\n`,
  );
  return file;
});

const project = (slug: string, group?: string): HelleProject => ({ slug, group: group ?? null });

test("credentials come from the env file the MCP wrapper sources", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* envFile();
      expect(yield* credentials({ home: "/nowhere", envFile: file })).toEqual({
        url: server.base,
        token: "token-abc",
      });
    }),
  ));

test("a missing token is a refusal, not an absent project", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory();
      const file = path.join(dir, "env");
      yield* fs.writeFileString(file, `HELLE_API_URL=${server.base}\n`);

      const result = yield* credentials({ home: "/nowhere", envFile: file }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(String(Result.isFailure(result) && result.failure.message)).toContain(
        "HELLE_API_TOKEN",
      );
    }),
  ));

test("an env file that is not there is a refusal naming it", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* credentials({ home: "/nowhere" }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(String(Result.isFailure(result) && result.failure.message)).toContain(
        "/nowhere/.config/helle/env",
      );
    }),
  ));

test("a project is resolved by its group and slug against the GitLab path", () => {
  const projects = [project("spilnu", "spilnu/frontend"), project("core", "spilnu/npm-packages")];
  expect(resolveProject(projects, "gitlab.cego.dk/spilnu/frontend/spilnu", "spilnu")).toEqual({
    _tag: "Project",
    slug: "spilnu",
  });
});

test("group case does not decide a match", () => {
  const projects = [project("kyc", "Players")];
  expect(resolveProject(projects, "gitlab.cego.dk/players/kyc", "kyc")).toEqual({
    _tag: "Project",
    slug: "kyc",
  });
});

test("a project with no group falls back to a slug equal to the repository name", () => {
  const projects = [project("monolith"), project("spilnu", "spilnu/frontend")];
  expect(resolveProject(projects, "gitlab.cego.dk/cego/monolith", "monolith")).toEqual({
    _tag: "Project",
    slug: "monolith",
  });
});

test("no match means the repository has no Helle project", () => {
  expect(
    resolveProject([project("spilnu", "spilnu/frontend")], "gitlab.cego.dk/cego/collie", "collie"),
  ).toEqual({ _tag: "None" });
});

test("several matches are ambiguous, and name them", () => {
  const projects = [project("sim", "a"), project("sim", "b")];
  expect(resolveProject(projects, null, "sim")).toEqual({
    _tag: "Ambiguous",
    slugs: ["sim", "sim"],
  });
});

test("a 500 from the project list is a refusal", () =>
  runEffect(
    Effect.gen(function* () {
      fake.listStatus = 500;
      const creds = { url: server.base, token: "token-abc" };
      const result = yield* helleProjects(creds).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(String(Result.isFailure(result) && result.failure.message)).toContain("500");
    }),
  ));

test("a rejected token is a refusal", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* helleProjects({ url: server.base, token: "wrong" }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(String(Result.isFailure(result) && result.failure.message)).toContain("401");
    }),
  ));

/** The gate as a Step declares it, with everything the runner would supply scripted. */
function gate(opts: {
  file: string;
  gitlabPath?: string | null;
  repoName?: string;
  claimed?: HelleClaim | null;
  answer?: string | null;
  lines: string[];
  recorded: (HelleClaim | null)[];
}) {
  return waitForHelle({
    home: "/nowhere",
    envFile: opts.file,
    gitlabPath:
      opts.gitlabPath === undefined ? "gitlab.cego.dk/spilnu/frontend/spilnu" : opts.gitlabPath,
    repoName: opts.repoName ?? "spilnu",
    claimed: opts.claimed ?? null,
    record: (claim) => Effect.sync(() => void opts.recorded.push(claim)),
    out: (line) => Effect.sync(() => void opts.lines.push(line)),
    ask: () => Effect.succeed(opts.answer ?? null),
    pollMs: 1,
  });
}

test("a repository with no Helle project carries straight on", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [{ slug: "spilnu", group: "spilnu/frontend", queue: [] }];
      const lines: string[] = [];
      const recorded: (HelleClaim | null)[] = [];
      const held = yield* gate({
        file: yield* envFile(),
        gitlabPath: "gitlab.cego.dk/cego/collie",
        repoName: "collie",
        lines,
        recorded,
      });

      expect(held).toBeNull();
      expect(recorded).toEqual([]);
      expect(lines.join("\n")).toContain("no Helle project");
      expect(fake.calls).not.toContain("POST /api/v1/projects/spilnu/claim");
    }),
  ));

test("several matching projects stop the Run rather than being guessed between", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [
        { slug: "spilnu", group: "spilnu/frontend", queue: [] },
        { slug: "spilnu", group: "other/group", queue: [] },
      ];
      const result = yield* gate({
        file: yield* envFile(),
        gitlabPath: null,
        lines: [],
        recorded: [],
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(String(Result.isFailure(result) && result.failure.message)).toContain("spilnu");
    }),
  ));

test("the gate claims, reports the queue as it moves, and returns once it is the holder", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        fake.projects = [
          {
            slug: "spilnu",
            group: "spilnu/frontend",
            holder: { user_id: OTHER, display_name: "someone" },
            queue: [{ user_id: OTHER }, { user_id: ME }],
          },
        ];
        fake.claims = [{ position: 2, already_queued: false }];
        const lines: string[] = [];
        const recorded: (HelleClaim | null)[] = [];
        const fiber = yield* Effect.forkScoped(gate({ file: yield* envFile(), lines, recorded }));

        // The queue moves up, and then the project becomes this token's own.
        yield* Effect.sleep(30);
        fake.projects[0]!.queue = [{ user_id: ME }];
        yield* Effect.sleep(30);
        fake.projects[0]!.holder = { user_id: ME, display_name: "mk" };
        fake.projects[0]!.queue = [];

        expect(yield* Fiber.join(fiber)).toEqual({ slug: "spilnu" });
        expect(recorded).toEqual([{ slug: "spilnu", claim: "mine" }]);
        const said = lines.join("\n");
        expect(said).toContain("position 2");
        expect(said).toContain("position 1");
        expect(said).toContain("holds spilnu");
      }),
    ),
  ));

test("a claim that was already the operator's is adopted only when they say so", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [
        {
          slug: "spilnu",
          group: "spilnu/frontend",
          holder: { user_id: ME, display_name: "mk" },
          queue: [],
        },
      ];
      fake.claims = [{ position: 0, already_queued: true }];
      const lines: string[] = [];
      const recorded: (HelleClaim | null)[] = [];
      const held = yield* gate({ file: yield* envFile(), answer: "yes", lines, recorded });

      expect(held).toEqual({ slug: "spilnu" });
      expect(recorded).toEqual([{ slug: "spilnu", claim: "adopted" }]);
    }),
  ));

test("a claim that was already the operator's is not taken over when they refuse", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [
        {
          slug: "spilnu",
          group: "spilnu/frontend",
          holder: { user_id: ME, display_name: "mk" },
          queue: [],
        },
      ];
      fake.claims = [{ position: 0, already_queued: true }];
      const recorded: (HelleClaim | null)[] = [];
      const result = yield* gate({
        file: yield* envFile(),
        answer: "no",
        lines: [],
        recorded,
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(recorded).toEqual([]);
    }),
  ));

test("a resumed Run does not ask again, and waits rather than assuming it holds it", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        fake.projects = [
          {
            slug: "spilnu",
            group: "spilnu/frontend",
            holder: { user_id: OTHER, display_name: "someone" },
            queue: [{ user_id: ME }],
          },
        ];
        fake.claims = [{ position: 1, already_queued: true }];
        const lines: string[] = [];
        const recorded: (HelleClaim | null)[] = [];
        const fiber = yield* Effect.forkScoped(
          waitForHelle({
            home: "/nowhere",
            envFile: yield* envFile(),
            gitlabPath: "gitlab.cego.dk/spilnu/frontend/spilnu",
            repoName: "spilnu",
            claimed: { slug: "spilnu", claim: "mine" },
            record: (claim) => Effect.sync(() => void recorded.push(claim)),
            out: (line) => Effect.sync(() => void lines.push(line)),
            ask: () => Effect.die("a resumed Run must not ask"),
            pollMs: 1,
          }),
        );

        yield* Effect.sleep(30);
        fake.projects[0]!.holder = { user_id: ME, display_name: "mk" };
        fake.projects[0]!.queue = [];

        expect(yield* Fiber.join(fiber)).toEqual({ slug: "spilnu" });
        expect(lines.join("\n")).toContain("position 1");
      }),
    ),
  ));

test("releasing gives the claim back", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [
        {
          slug: "spilnu",
          group: "spilnu/frontend",
          holder: { user_id: ME, display_name: "mk" },
          queue: [],
        },
      ];
      yield* releaseClaim({ url: server.base, token: "token-abc" }, "spilnu");

      expect(fake.projects[0]!.holder).toBeUndefined();
      expect(fake.calls).toContain("POST /api/v1/projects/spilnu/release");
    }),
  ));

test("a project Helle does not know is a 404 refusal, not silence", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* releaseClaim({ url: server.base, token: "token-abc" }, "gone").pipe(
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(String(Result.isFailure(result) && result.failure.message)).toContain("404");
    }),
  ));

test("adopting a claim stops the Run that held it and its children, waits them out, and closes their agents before taking the claim", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-handover-" });
      const hold = (runId: string, slug: string) =>
        fs
          .makeDirectory(`${dir}/runs/${runId}`, { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(
                `${dir}/runs/${runId}/helle.json`,
                `{"slug":"${slug}","claim":"mine"}`,
              ),
            ),
          );
      const held = (runId: string) =>
        fs.exists(`${dir}/runs/${runId}/helle.json`).pipe(Effect.orElseSucceed(() => false));
      /** What the host did, in order, and the record's presence each time it looked. */
      const said: string[] = [];
      const host = (over: {
        readonly children?: ReadonlyArray<string>;
        readonly stopsAfter?: number;
        readonly left?: ReadonlyArray<string>;
        readonly lateLeft?: ReadonlyArray<string>;
      }) => {
        let looks = 0;
        return {
          stop: (runId: string) =>
            Effect.sync(() => {
              said.push(`stop ${runId}`);
              return { runs: [runId, ...(over.children ?? [])], left: over.left ?? [] };
            }),
          stopped: (runId: string) =>
            Effect.sync(() => {
              looks += 1;
              said.push(`looked at ${runId}`);
              return looks > (over.stopsAfter ?? 0);
            }),
          halt: (runId: string) =>
            held("r-old").pipe(
              Effect.map((record) => {
                said.push(`closed ${runId}${record ? "" : " after the claim moved"}`);
                return { stopped: [], left: over.lateLeft ?? [] };
              }),
            ),
          patience: { everyMs: 10, forMs: 5_000 },
        };
      };

      yield* hold("r-old", "project");
      yield* hold("r-elsewhere", "other");
      const handed = yield* handOverClaim({
        dir,
        slug: "project",
        to: "r-new",
        runs: ["r-old", "r-elsewhere", "r-new"],
        ...host({ children: ["r-child"], stopsAfter: 2 }),
      });
      expect(handed).toEqual(["r-old"]);
      // The Run and its child are stopped as an operator's stop does, both are waited out,
      // and every agent they have is closed again before the record goes: one started
      // after the stop would otherwise go on working on what the claim guards.
      expect(said).toEqual([
        "stop r-old",
        "looked at r-old",
        "looked at r-old",
        "looked at r-old",
        "looked at r-child",
        "closed r-old",
        "closed r-child",
      ]);
      expect(yield* held("r-old")).toBe(false);
      expect(yield* held("r-elsewhere")).toBe(true);

      // An agent the stop could not close could still change what the claim guards.
      yield* hold("r-old", "project");
      const stuck = yield* handOverClaim({
        dir,
        slug: "project",
        to: "r-new",
        runs: ["r-old"],
        ...host({ left: ["impl-1's pane would not close"] }),
      }).pipe(Effect.flip);
      expect(stuck.message).toContain("impl-1's pane would not close");
      expect(yield* held("r-old")).toBe(true);

      // Nor one that started before the Run stopped and will not close now.
      const late = yield* handOverClaim({
        dir,
        slug: "project",
        to: "r-new",
        runs: ["r-old"],
        ...host({ lateLeft: ["impl-2's pane would not close"] }),
      }).pipe(Effect.flip);
      expect(late.message).toContain("impl-2's pane would not close");
      expect(yield* held("r-old")).toBe(true);

      // A Run that does not stop keeps the claim, and the adoption says why.
      const running = yield* handOverClaim({
        dir,
        slug: "project",
        to: "r-new",
        runs: ["r-old"],
        ...host({ stopsAfter: Number.POSITIVE_INFINITY }),
        patience: { everyMs: 10, forMs: 50 },
      }).pipe(Effect.flip);
      expect(running.message).toContain("r-old is still running");
      expect(yield* held("r-old")).toBe(true);
    }).pipe(Effect.scoped),
  ));
