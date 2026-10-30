// Helle as Collie's own client, and the gate a Step declares with `waits: helle`.
// Everything runs against a stand-in server this test controls, because the states
// that matter — someone else holding the project, a queue that moves, a 500 — are
// exactly the ones a real Helle will not produce on demand.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, Fiber, FileSystem, Path, Result, Schedule, Schema } from "effect";
import { runEffect } from "./support/effect";
import { events, openHost, runDirOf, until, workspace } from "./support/host";
import { readAudit } from "../src/audit";
import { frontDoor, socketOf } from "../src/host";
import { Host } from "../src/sdk";
import { callFlockTool, chatDoor } from "../desktop/src/bun/flock-tools";
import {
  credentials,
  helleHolders,
  helleProjects,
  releaseClaim,
  resolveProject,
  resolveProjects,
  waitForHelle,
  type HelleClaim,
  type HelleProject,
} from "../src/helle";
import { HELLE_URL } from "../src/helle-url";
import { foundationLayer, handOverClaim } from "../src/engine";
import { ClaimedSchema } from "../src/sdk";

const ME = "6b9ba520-user";
const OTHER = "2dd236ac-other";

/** One project as Helle reports it, holder and queue included. */
interface Fake {
  projects: {
    slug: string;
    group?: string;
    shorthand?: string[] | null;
    holder?: { user_id: string; display_name: string };
    queue: { user_id: string }[];
  }[];
  /** Status to answer `GET /projects` with, for the failures that are refusals. */
  listStatus: number;
  meStatus: number;
  /** What a claim answers, in the order claims arrive; `taken` is who got there first. */
  claims: {
    position: number;
    already_queued: boolean;
    taken?: { user_id: string; display_name: string };
  }[];
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
        const { taken, ...answer } = fake.claims.shift() ?? { position: 0, already_queued: false };
        if (taken) project.holder = taken;
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
const envFile = Effect.fn("test.envFile")(function* (token = "token-abc") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const file = path.join(dir, "env");
  yield* fs.writeFileString(
    file,
    `# helle\nexport HELLE_API_URL=https://elsewhere.example\nHELLE_API_TOKEN=${token}\n`,
  );
  return file;
});

const project = (slug: string, group?: string, shorthand?: string[]): HelleProject => {
  const named: HelleProject = { slug, group: group ?? null };
  return shorthand === undefined ? named : { ...named, shorthand };
};

test("the token comes from the env file the MCP wrapper sources; the URL is always Helle's", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* envFile();
      expect(yield* credentials({ home: "/nowhere", envFile: file })).toEqual({
        url: HELLE_URL,
        token: "token-abc",
      });
      expect(yield* credentials({ home: "/nowhere", envFile: file, url: server.base })).toEqual({
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
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "env");
      yield* fs.writeFileString(file, `HELLE_API_URL=${HELLE_URL}\n`);

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

test("a project with no group is matched by the GitLab path's name, not the clone's", () => {
  const projects = [project("monolith"), project("spilnu", "spilnu/frontend")];
  expect(resolveProject(projects, "gitlab.cego.dk/cego/monolith", "70d48e486933e63")).toEqual({
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

/** Helle's projects in the monorepo's own group, and one elsewhere named like an app. */
const FRONTEND = [
  project("spilnu", "spilnu/frontend"),
  project("happytiger", "spilnu/frontend"),
  project("playground", "spilnu/frontend"),
  project("chat", "Players"),
];
const MONOREPO = "gitlab.cego.dk/spilnu/frontend/monorepo";
const release = (over: Partial<Parameters<typeof resolveProjects>[1]> = {}) => ({
  repositoryPath: MONOREPO,
  repoName: "monorepo",
  applications: [],
  jobs: [],
  declared: null,
  ...over,
});

test("a monorepo's release needs the project of every application it deploys, in its own group", () => {
  expect(
    resolveProjects(
      FRONTEND,
      release({ applications: ["spilnu"], jobs: ["stage:happytiger", "prod:happytiger"] }),
    ),
  ).toEqual({ _tag: "Projects", slugs: ["happytiger", "spilnu"] });
});

test("a deploy job naming another group's project does not claim it", () => {
  expect(resolveProjects(FRONTEND, release({ jobs: ["stage:chat", "stage:spilnu"] }))).toEqual({
    _tag: "Projects",
    slugs: ["spilnu"],
  });
});

test("a project of a group the repository's group merely ends with is not the repository's group's", () => {
  const frontend = [project("spilnu", "spilnu/frontend"), project("chat", "frontend")];
  expect(resolveProjects(frontend, release({ jobs: ["stage:chat", "stage:spilnu"] }))).toEqual({
    _tag: "Projects",
    slugs: ["spilnu"],
  });
  const resolved = resolveProjects(frontend, release({ applications: ["chat"] }));
  expect(resolved._tag).toBe("Unresolved");
});

/** The shape of Helle's own list on 2026-10-29: no `monorepo`, and the backoffice filed apart from the brands. */
const HELLE = [
  project("support-backoffice", "spilnu/backoffices", ["sbo"]),
  project("happytiger", "spilnu/frontend"),
  project("spilnu", "spilnu/frontend"),
  project("crushit-uk", "spilnu/frontend"),
  project("spinking-dk", "spilnu/frontend"),
];

test("a repository that is its own Helle project needs that project alone", () => {
  expect(
    resolveProjects(
      HELLE,
      release({
        repositoryPath: "gitlab.cego.dk/spilnu/frontend/support-backoffice",
        repoName: "support-backoffice",
        applications: ["spilnu"],
        jobs: ["stage:happytiger"],
      }),
    ),
  ).toEqual({ _tag: "Projects", slugs: ["support-backoffice"] });
});

test("a repository with no Helle project of its own needs each brand its applications and stage jobs name", () => {
  expect(
    resolveProjects(
      HELLE,
      release({ applications: ["spilnu"], jobs: ["stage:happytiger", "stage:crushit-uk"] }),
    ),
  ).toEqual({ _tag: "Projects", slugs: ["crushit-uk", "happytiger", "spilnu"] });
});

test("an application Helle has no project for leaves the release unresolved", () => {
  const resolved = resolveProjects(FRONTEND, release({ applications: ["spilnu", "newapp"] }));
  expect(resolved._tag).toBe("Unresolved");
  expect(resolved._tag === "Unresolved" && resolved.why).toContain("newapp");
});

test("a release that resolves to no project at all is unresolved, never carried on without", () => {
  const resolved = resolveProjects(FRONTEND, release({ jobs: ["deploy:stage"] }));
  expect(resolved._tag).toBe("Unresolved");
  expect(resolved._tag === "Unresolved" && resolved.why).toContain("monorepo");
});

test("several projects the repository could be leave it unresolved", () => {
  const resolved = resolveProjects(
    [project("sim", "a"), project("sim", "b")],
    release({ repositoryPath: null, repoName: "sim" }),
  );
  expect(resolved._tag).toBe("Unresolved");
});

test("a repository that declares its projects is held to exactly those, and [] declares none", () => {
  expect(
    resolveProjects(FRONTEND, release({ jobs: ["stage:spilnu"], declared: ["playground"] })),
  ).toEqual({ _tag: "Projects", slugs: ["playground"] });
  expect(resolveProjects(FRONTEND, release({ jobs: ["stage:spilnu"], declared: [] }))).toEqual({
    _tag: "Projects",
    slugs: [],
  });
  const unknown = resolveProjects(FRONTEND, release({ declared: ["gone"] }));
  expect(unknown._tag === "Unresolved" && unknown.why).toContain("gone");
});

const SHORTHANDS = [
  project("spilnu", "spilnu/frontend", ["sn"]),
  project("happytiger", "spilnu/frontend"),
  project("playground", "spilnu/frontend"),
  project("sneaky", "Players", ["sn"]),
];

test("a shorthand resolves an application and a deploy job to its project's slug, within the repository's group", () => {
  expect(resolveProjects(SHORTHANDS, release({ applications: ["SN"] }))).toEqual({
    _tag: "Projects",
    slugs: ["spilnu"],
  });
  expect(resolveProjects(SHORTHANDS, release({ jobs: ["stage:sn", "stage:happytiger"] }))).toEqual({
    _tag: "Projects",
    slugs: ["happytiger", "spilnu"],
  });
});

test("a repository whose own name is a project's shorthand resolves to that project", () => {
  const projects = [project("frontend-web", "spilnu/frontend", ["web"]), project("monolith")];
  expect(resolveProject(projects, "gitlab.cego.dk/spilnu/frontend/web", "web")).toEqual({
    _tag: "Project",
    slug: "frontend-web",
  });
  expect(resolveProject([project("monolith", undefined, ["mono"])], null, "mono")).toEqual({
    _tag: "Project",
    slug: "monolith",
  });
});

test("a .collie/helle.json entry naming a shorthand resolves to its slug, and one neither slug nor shorthand is unknown", () => {
  const inGroup = SHORTHANDS.filter((one) => one.group === "spilnu/frontend");
  expect(resolveProjects(inGroup, release({ declared: ["sn", "playground"] }))).toEqual({
    _tag: "Projects",
    slugs: ["playground", "spilnu"],
  });
  const unknown = resolveProjects(inGroup, release({ declared: ["spil"] }));
  expect(unknown._tag === "Unresolved" && unknown.why).toBe(
    ".collie/helle.json names spil, which Helle does not know",
  );
});

test("a shorthand two projects answer to is unresolved, naming both", () => {
  const twice = [...SHORTHANDS, project("snake", "spilnu/frontend", ["sn"])];
  for (const over of [{ applications: ["sn"] }, { jobs: ["stage:sn"] }, { declared: ["sn"] }]) {
    const resolved = resolveProjects(twice, release(over));
    expect(resolved._tag).toBe("Unresolved");
    expect(resolved._tag === "Unresolved" && resolved.why).toContain("spilnu");
    expect(resolved._tag === "Unresolved" && resolved.why).toContain("snake");
  }
});

test("a claim an earlier release journaled reads as what it held, and holding none asks again", () => {
  const decode = Schema.decodeUnknownSync(ClaimedSchema);
  expect(decode({ slug: "spilnu" })).toEqual({ slugs: ["spilnu"] });
  expect("unresolved" in decode(null)).toBe(true);
  expect(decode({ slugs: ["happytiger", "spilnu"] })).toEqual({ slugs: ["happytiger", "spilnu"] });
  expect(Schema.encodeSync(ClaimedSchema)({ slugs: ["spilnu"] })).toEqual({ slugs: ["spilnu"] });
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
  repositoryPath?: string | null;
  repoName?: string;
  deploys?: { applications: string[]; jobs: string[] } | null;
  free?: boolean;
  claimed?: HelleClaim[];
  answer?: string | null;
  lines: string[];
  recorded: (HelleClaim | null)[];
  queued?: number[];
  ended?: string[];
  forgotten?: string[];
}) {
  return waitForHelle({
    home: "/nowhere",
    envFile: opts.file,
    url: server.base,
    repositoryPath:
      opts.repositoryPath === undefined
        ? "gitlab.cego.dk/spilnu/frontend/spilnu"
        : opts.repositoryPath,
    repoName: opts.repoName ?? "spilnu",
    deploys: opts.deploys ?? null,
    declared: null,
    free: opts.free ?? false,
    claimed: opts.claimed ?? [],
    record: (claim) => Effect.sync(() => void opts.recorded.push(claim)),
    forget: (slug) => Effect.sync(() => void opts.forgotten?.push(slug)),
    out: (line) => Effect.sync(() => void opts.lines.push(line)),
    ask: () => Effect.succeed(opts.answer ?? null),
    queued: (_slug, position) => Effect.sync(() => void opts.queued?.push(position)),
    ended: () => Effect.sync(() => void opts.ended?.push("ended")),
    pollMs: 1,
  });
}

test("a repository with no Helle project is unresolved, and nothing is claimed", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [{ slug: "spilnu", group: "spilnu/frontend", queue: [] }];
      const lines: string[] = [];
      const recorded: (HelleClaim | null)[] = [];
      const ended: string[] = [];
      const held = yield* gate({
        file: yield* envFile(),
        repositoryPath: "gitlab.cego.dk/cego/collie",
        repoName: "collie",
        lines,
        recorded,
        ended,
      });

      expect(held._tag).toBe("Unresolved");
      expect(held._tag === "Unresolved" && held.why).toContain("no Helle project for collie");
      expect(ended).toEqual(["ended"]);
      expect(recorded).toEqual([]);
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
        repositoryPath: null,
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
        const queued: number[] = [];
        const ended: string[] = [];
        const fiber = yield* Effect.forkScoped(
          gate({ file: yield* envFile(), lines, recorded, queued, ended }),
        );

        // The queue moves up once the gate has said where it stands, and then the project
        // becomes this token's own: moved on what the gate has seen, not on the clock.
        const saidSoFar = (text: string) =>
          Effect.sync(() => lines.some((line) => line.includes(text))).pipe(
            Effect.repeat({ until: (seen) => seen, schedule: Schedule.spaced("5 millis") }),
          );
        yield* saidSoFar("position 2");
        // Told again on every read, so a wait that has stopped moving is still seen to age.
        yield* Effect.sync(() => queued.length).pipe(
          Effect.repeat({ until: (told) => told >= 3, schedule: Schedule.spaced("5 millis") }),
        );
        fake.projects[0]!.queue = [{ user_id: ME }];
        yield* saidSoFar("position 1");
        fake.projects[0]!.holder = { user_id: ME, display_name: "mk" };
        fake.projects[0]!.queue = [];

        expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Held", slugs: ["spilnu"] });
        expect(recorded).toEqual([{ slug: "spilnu", claim: "mine" }]);
        const said = lines.join("\n");
        expect(said).toContain("position 2");
        expect(said).toContain("position 1");
        expect(said).toContain("holds spilnu");
        expect([...new Set(queued)]).toEqual([2, 1]);
        expect(ended).toEqual(["ended"]);
      }),
    ),
  ));

test("a gate interrupted in the queue is not told its wait ended", () =>
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
        const queued: number[] = [];
        const ended: string[] = [];
        const fiber = yield* Effect.forkScoped(
          gate({ file: yield* envFile(), lines: [], recorded: [], queued, ended }),
        );
        yield* Effect.sync(() => queued.length).pipe(
          Effect.repeat({ until: (told) => told >= 1, schedule: Schedule.spaced("5 millis") }),
        );
        yield* Fiber.interrupt(fiber);
        expect(ended).toEqual([]);
      }),
    ),
  ));

test("a monorepo's release holds every application's project before it answers", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [
        { slug: "spilnu", group: "spilnu/frontend", queue: [] },
        { slug: "happytiger", group: "spilnu/frontend", queue: [] },
        { slug: "playground", group: "spilnu/frontend", queue: [] },
      ];
      const lines: string[] = [];
      const recorded: (HelleClaim | null)[] = [];
      const held = yield* gate({
        file: yield* envFile(),
        repositoryPath: "gitlab.cego.dk/spilnu/frontend/monorepo",
        repoName: "monorepo",
        deploys: { applications: ["spilnu"], jobs: ["stage:happytiger"] },
        lines,
        recorded,
      });

      expect(held).toEqual({ _tag: "Held", slugs: ["happytiger", "spilnu"] });
      expect(recorded).toEqual([
        { slug: "happytiger", claim: "mine" },
        { slug: "spilnu", claim: "mine" },
      ]);
      expect(fake.calls).not.toContain("POST /api/v1/projects/playground/claim");
      expect(lines.join("\n")).toContain("holds happytiger");
      expect(lines.join("\n")).toContain("holds spilnu");
    }),
  ));

test("a project Helle lists with no shorthand, or a null one, still resolves by its slug", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [
        { slug: "spilnu", group: "spilnu/frontend", shorthand: null, queue: [] },
        { slug: "happytiger", group: "spilnu/frontend", queue: [] },
      ];
      const held = yield* gate({
        file: yield* envFile(),
        repositoryPath: "gitlab.cego.dk/spilnu/frontend/monorepo",
        repoName: "monorepo",
        deploys: { applications: ["spilnu", "happytiger"], jobs: [] },
        lines: [],
        recorded: [],
      });
      expect(held).toEqual({ _tag: "Held", slugs: ["happytiger", "spilnu"] });
    }),
  ));

test("the gate claims, holds and gives back a project named by its shorthand through its slug's routes", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [{ slug: "spilnu", group: "spilnu/frontend", shorthand: ["sn"], queue: [] }];
      const lines: string[] = [];
      const recorded: (HelleClaim | null)[] = [];
      const held = yield* gate({
        file: yield* envFile(),
        repositoryPath: "gitlab.cego.dk/spilnu/frontend/monorepo",
        repoName: "monorepo",
        deploys: { applications: ["sn"], jobs: ["stage:sn"] },
        lines,
        recorded,
      });
      expect(held).toEqual({ _tag: "Held", slugs: ["spilnu"] });
      expect(recorded).toEqual([{ slug: "spilnu", claim: "mine" }]);
      expect(lines).toContain("✓ this Run holds spilnu");
      yield* releaseClaim({ url: server.base, token: "token-abc" }, recorded[0]!.slug);
      expect(fake.calls.filter((call) => call.startsWith("POST"))).toEqual([
        "POST /api/v1/projects/spilnu/claim",
        "POST /api/v1/projects/spilnu/release",
      ]);
    }),
  ));

test("someone else's claim on one project keeps the gate waiting, and the next is not queued for meanwhile", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        fake.projects = [
          {
            slug: "happytiger",
            group: "spilnu/frontend",
            holder: { user_id: OTHER, display_name: "someone" },
            queue: [{ user_id: ME }],
          },
          { slug: "spilnu", group: "spilnu/frontend", queue: [] },
        ];
        fake.claims = [{ position: 1, already_queued: false }];
        const lines: string[] = [];
        const fiber = yield* Effect.forkScoped(
          gate({
            file: yield* envFile(),
            repositoryPath: "gitlab.cego.dk/spilnu/frontend/monorepo",
            repoName: "monorepo",
            deploys: { applications: ["spilnu", "happytiger"], jobs: [] },
            lines,
            recorded: [],
          }),
        );

        yield* Effect.sync(() =>
          lines.some((line) => line.includes("waiting for happytiger")),
        ).pipe(Effect.repeat({ until: (seen) => seen, schedule: Schedule.spaced("5 millis") }));
        yield* Effect.sleep(30);
        expect(fiber.pollUnsafe()).toBeUndefined();
        expect(fake.calls).not.toContain("POST /api/v1/projects/spilnu/claim");

        fake.projects[0]!.holder = { user_id: ME, display_name: "mk" };
        fake.projects[0]!.queue = [];
        expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Held", slugs: ["happytiger", "spilnu"] });
      }),
    ),
  ));

const DANN = { user_id: OTHER, display_name: "Dann" };
const busyFrontend = () => [
  { slug: "spilnu", group: "spilnu/frontend", shorthand: ["sn"], holder: DANN, queue: [] },
  { slug: "happytiger", group: "spilnu/frontend", queue: [] },
  {
    slug: "playground",
    group: "spilnu/frontend",
    holder: { user_id: ME, display_name: "mk" },
    queue: [],
  },
];
const monorepo = {
  repositoryPath: "gitlab.cego.dk/spilnu/frontend/monorepo",
  repoName: "monorepo",
};

test("who holds: each needed project's holder is read, and no queue is joined", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [
        ...busyFrontend(),
        { slug: "chat", group: "spilnu/frontend", queue: [{ user_id: OTHER }] },
      ];
      const read = yield* helleHolders({
        home: "/nowhere",
        envFile: yield* envFile(),
        url: server.base,
        ...monorepo,
        deploys: {
          applications: ["spilnu", "happytiger", "playground", "chat"],
          jobs: ["stage:sn", "deploy happytiger/stage", "deploy-stage-chat", "e2e-stage"],
        },
        declared: null,
      });
      expect(read).toEqual({
        _tag: "Read",
        projects: [
          { slug: "chat", holder: "2dd236ac-other" },
          { slug: "happytiger", holder: null },
          { slug: "playground", holder: null },
          { slug: "spilnu", holder: "Dann" },
        ],
        applications: [
          { name: "spilnu", needs: ["spilnu"] },
          { name: "happytiger", needs: ["happytiger"] },
          { name: "playground", needs: ["playground"] },
          { name: "chat", needs: ["chat"] },
        ],
        jobs: [
          { name: "stage:sn", applications: ["spilnu"] },
          { name: "deploy happytiger/stage", applications: ["happytiger"] },
          { name: "deploy-stage-chat", applications: [] },
          { name: "e2e-stage", applications: [] },
        ],
      });
      expect(fake.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    }),
  ));

test("who holds: every application of a repository that is its own project needs that project alone, and every declared one", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [
        ...busyFrontend(),
        { slug: "monorepo", group: "spilnu/frontend", queue: [] },
      ];
      const where = {
        home: "/nowhere",
        envFile: yield* envFile(),
        url: server.base,
        ...monorepo,
        deploys: { applications: ["spilnu", "happytiger"], jobs: [] },
      };
      const own = yield* helleHolders({ ...where, declared: null });
      expect(own._tag === "Read" && own.applications).toEqual([
        { name: "spilnu", needs: ["monorepo"] },
        { name: "happytiger", needs: ["monorepo"] },
      ]);
      const declared = yield* helleHolders({ ...where, declared: ["happytiger", "playground"] });
      expect(declared._tag === "Read" && declared.applications).toEqual([
        { name: "spilnu", needs: ["happytiger", "playground"] },
        { name: "happytiger", needs: ["happytiger", "playground"] },
      ]);
    }),
  ));

test("what is free: only the free projects are claimed, in Helle's order, and no queue is waited on", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = busyFrontend().slice(0, 2);
      const recorded: (HelleClaim | null)[] = [];
      const held = yield* gate({
        file: yield* envFile(),
        ...monorepo,
        deploys: { applications: ["spilnu", "happytiger"], jobs: [] },
        free: true,
        lines: [],
        recorded,
      }).pipe(Effect.timeout("2 seconds"));

      expect(held).toEqual({
        _tag: "Held",
        slugs: ["happytiger"],
        left: [{ slug: "spilnu", holder: "Dann" }],
      });
      expect(recorded).toEqual([{ slug: "happytiger", claim: "mine" }]);
      expect(fake.calls.filter((call) => call.startsWith("POST"))).toEqual([
        "POST /api/v1/projects/happytiger/claim",
      ]);
    }),
  ));

test("what is free: a project someone took before the claim came back queued is given back and named with its holder", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = busyFrontend().slice(1, 2);
      fake.claims = [{ position: 1, already_queued: false, taken: DANN }];
      const forgotten: string[] = [];
      const held = yield* gate({
        file: yield* envFile(),
        ...monorepo,
        deploys: { applications: ["happytiger"], jobs: [] },
        free: true,
        lines: [],
        recorded: [],
        forgotten,
      }).pipe(Effect.timeout("2 seconds"));

      expect(held).toEqual({
        _tag: "Held",
        slugs: [],
        left: [{ slug: "happytiger", holder: "Dann" }],
      });
      expect(fake.calls.filter((call) => call.startsWith("POST"))).toEqual([
        "POST /api/v1/projects/happytiger/claim",
        "POST /api/v1/projects/happytiger/release",
      ]);
      expect(forgotten).toEqual(["happytiger"]);
    }),
  ));

test("what is free: a project the operator already holds counts as free once they adopt it", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = busyFrontend();
      fake.claims = [{ position: 0, already_queued: true }];
      const recorded: (HelleClaim | null)[] = [];
      const held = yield* gate({
        file: yield* envFile(),
        ...monorepo,
        deploys: { applications: ["spilnu", "playground"], jobs: [] },
        free: true,
        answer: "yes",
        lines: [],
        recorded,
      }).pipe(Effect.timeout("2 seconds"));

      expect(held).toEqual({
        _tag: "Held",
        slugs: ["playground"],
        left: [{ slug: "spilnu", holder: "Dann" }],
      });
      expect(recorded).toEqual([{ slug: "playground", claim: "adopted" }]);
    }),
  ));

test("a claim lost while the gate waited for the next gives the later ones back and takes them again in order", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        fake.projects = [
          { slug: "happytiger", group: "spilnu/frontend", queue: [] },
          {
            slug: "spilnu",
            group: "spilnu/frontend",
            holder: { user_id: OTHER, display_name: "someone" },
            queue: [],
          },
        ];
        fake.claims = [
          { position: 0, already_queued: false },
          { position: 1, already_queued: false },
          { position: 1, already_queued: false },
        ];
        const lines: string[] = [];
        const recorded: (HelleClaim | null)[] = [];
        const forgotten: string[] = [];
        const fiber = yield* Effect.forkScoped(
          gate({
            file: yield* envFile(),
            repositoryPath: "gitlab.cego.dk/spilnu/frontend/monorepo",
            repoName: "monorepo",
            deploys: { applications: ["spilnu", "happytiger"], jobs: [] },
            lines,
            recorded,
            forgotten,
          }),
        );
        const saidSoFar = (text: string) =>
          Effect.sync(() => lines.some((line) => line.includes(text))).pipe(
            Effect.repeat({
              until: (seen) => seen,
              schedule: Schedule.spaced("5 millis"),
            }),
          );

        yield* saidSoFar("waiting for spilnu");
        const [happytiger, spilnu] = fake.projects;
        happytiger!.holder = { user_id: OTHER, display_name: "someone" };
        happytiger!.queue = [];
        spilnu!.holder = { user_id: ME, display_name: "mk" };
        spilnu!.queue = [];
        yield* saidSoFar("waiting for happytiger");
        expect(fiber.pollUnsafe()).toBeUndefined();
        expect(spilnu!.holder).toBeUndefined();
        expect(forgotten).toEqual(["spilnu"]);

        happytiger!.holder = { user_id: ME, display_name: "mk" };
        expect(yield* Fiber.join(fiber)).toEqual({
          _tag: "Held",
          slugs: ["happytiger", "spilnu"],
        });
        expect(fake.calls.filter((call) => call.startsWith("POST"))).toEqual([
          "POST /api/v1/projects/happytiger/claim",
          "POST /api/v1/projects/spilnu/claim",
          "POST /api/v1/projects/spilnu/release",
          "POST /api/v1/projects/happytiger/claim",
          "POST /api/v1/projects/spilnu/claim",
        ]);
        expect(recorded).toEqual([
          { slug: "happytiger", claim: "mine" },
          { slug: "spilnu", claim: "mine" },
          { slug: "spilnu", claim: "mine" },
        ]);
      }),
    ),
  ));

/** Helle as several users see it: a token is the user, and a release passes the project on. */
const sharedHelle = Effect.fn("test.sharedHelle")(function* (
  projects: { slug: string; holder?: { user_id: string }; queue: { user_id: string }[] }[],
) {
  const helle = Bun.serve({
    port: 0,
    fetch: (request) => {
      const user = request.headers.get("authorization")!.replace("Bearer ", "");
      const path = new URL(request.url).pathname.replace("/api/v1", "");
      if (path === "/me") return Response.json({ user_id: user });
      if (path === "/projects") return Response.json(projects);
      const one = /^\/projects\/([^/]+)(\/claim|\/release)?$/.exec(path);
      const project = projects.find((p) => p.slug === one?.[1]);
      if (!one || !project) return Response.json({}, { status: 404 });
      if (one[2] === "/claim") {
        const already =
          project.holder?.user_id === user || project.queue.some((m) => m.user_id === user);
        if (!already) {
          if (project.holder) project.queue.push({ user_id: user });
          else project.holder = { user_id: user };
        }
        const at = project.queue.findIndex((m) => m.user_id === user);
        return Response.json({ position: at + 1, already_queued: already });
      }
      if (one[2] === "/release") {
        if (project.holder?.user_id === user) project.holder = project.queue.shift();
        else project.queue = project.queue.filter((m) => m.user_id !== user);
        return Response.json({ released: true });
      }
      return Response.json(project);
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => void helle.stop(true)));
  const url = `http://127.0.0.1:${helle.port}`;
  const lines: string[] = [];
  const release = (user: string, claimed: HelleClaim[], ask: () => string | null) =>
    Effect.gen(function* () {
      return yield* waitForHelle({
        home: "/nowhere",
        envFile: yield* envFile(user),
        url,
        repositoryPath: null,
        repoName: "monorepo",
        deploys: null,
        declared: ["alpha", "beta"],
        claimed,
        record: () => Effect.void,
        forget: () => Effect.void,
        out: (line) => Effect.sync(() => void lines.push(`${user}: ${line}`)),
        ask: () => Effect.sync(ask),
        pollMs: 1,
      });
    });
  return { url, lines, release };
});

test("Runs resuming with each other's next claim give theirs back rather than deadlock", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { url, lines, release } = yield* sharedHelle([
          { slug: "alpha", holder: { user_id: "B" }, queue: [] },
          { slug: "beta", holder: { user_id: "A" }, queue: [] },
        ]);
        const unasked = () => {
          throw new Error("every claim is already recorded");
        };

        const a = yield* Effect.forkScoped(
          release(
            "A",
            [
              { slug: "alpha", claim: "mine" },
              { slug: "beta", claim: "mine" },
            ],
            unasked,
          ),
        );
        const b = yield* Effect.forkScoped(
          release("B", [{ slug: "alpha", claim: "mine" }], unasked),
        );

        expect(yield* Fiber.join(b).pipe(Effect.timeout("2 seconds"))).toEqual({
          _tag: "Held",
          slugs: ["alpha", "beta"],
        });
        expect(lines).toContain(
          "A: ⚠ this Run does not hold alpha, so it gives back beta to take them again in order",
        );
        yield* releaseClaim({ url, token: "B" }, "alpha");
        yield* releaseClaim({ url, token: "B" }, "beta");
        expect(yield* Fiber.join(a).pipe(Effect.timeout("2 seconds"))).toEqual({
          _tag: "Held",
          slugs: ["alpha", "beta"],
        });
      }),
    ),
  ));

test("a later project the operator already holds is taken over and given back before an earlier one is waited for", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { url, lines, release } = yield* sharedHelle([
          { slug: "alpha", holder: { user_id: "A" }, queue: [] },
          { slug: "beta", holder: { user_id: "B" }, queue: [] },
        ]);
        const asked: string[] = [];
        const yes = (user: string) => () => (asked.push(user), "yes");

        const b = yield* Effect.forkScoped(release("B", [], yes("B")));
        const a = yield* Effect.forkScoped(release("A", [], yes("A")));

        expect(yield* Fiber.join(a).pipe(Effect.timeout("2 seconds"))).toEqual({
          _tag: "Held",
          slugs: ["alpha", "beta"],
        });
        expect(lines).toContain(
          "B: ⚠ this Run does not hold alpha, so it gives back beta to take them again in order",
        );
        expect(asked.sort()).toEqual(["A", "B"]);
        yield* releaseClaim({ url, token: "A" }, "alpha");
        yield* releaseClaim({ url, token: "A" }, "beta");
        expect(yield* Fiber.join(b).pipe(Effect.timeout("2 seconds"))).toEqual({
          _tag: "Held",
          slugs: ["alpha", "beta"],
        });
      }),
    ),
  ));

test("a later project the operator will not have taken over stops the Run before it waits", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { release } = yield* sharedHelle([
          { slug: "alpha", holder: { user_id: "A" }, queue: [] },
          { slug: "beta", holder: { user_id: "B" }, queue: [] },
        ]);

        const result = yield* release("B", [], () => "no").pipe(
          Effect.timeout("2 seconds"),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(String(Result.isFailure(result) && result.failure.message)).toContain(
          "the Helle claim on beta was already yours and was not taken over",
        );
      }),
    ),
  ));

test("a release whose projects cannot be resolved claims nothing", () =>
  runEffect(
    Effect.gen(function* () {
      fake.projects = [{ slug: "spilnu", group: "spilnu/frontend", queue: [] }];
      const held = yield* gate({
        file: yield* envFile(),
        repositoryPath: "gitlab.cego.dk/spilnu/frontend/monorepo",
        repoName: "monorepo",
        deploys: { applications: ["spilnu", "newapp"], jobs: [] },
        lines: [],
        recorded: [],
      });

      expect(held._tag).toBe("Unresolved");
      expect(fake.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    }),
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

      expect(held).toEqual({ _tag: "Held", slugs: ["spilnu"] });
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
            url: server.base,
            repositoryPath: "gitlab.cego.dk/spilnu/frontend/spilnu",
            repoName: "spilnu",
            deploys: null,
            declared: null,
            claimed: [{ slug: "spilnu", claim: "mine" }],
            record: (claim) => Effect.sync(() => void recorded.push(claim)),
            forget: () => Effect.die("a resumed Run that keeps its claim forgets none"),
            out: (line) => Effect.sync(() => void lines.push(line)),
            ask: () => Effect.die("a resumed Run must not ask"),
            pollMs: 1,
          }),
        );

        yield* until(
          () => Effect.succeed(lines.length),
          (count) => count > 0,
        );
        yield* Effect.sleep(30);
        fake.projects[0]!.holder = { user_id: ME, display_name: "mk" };
        fake.projects[0]!.queue = [];

        expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Held", slugs: ["spilnu"] });
        expect(lines.join("\n")).toContain("position 1");
      }),
    ),
  ));

test("a resumed Run granted the claim while it was down is told its wait ended", () =>
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
      const ended: string[] = [];
      const held = yield* gate({
        file: yield* envFile(),
        claimed: [{ slug: "spilnu", claim: "mine" }],
        lines: [],
        recorded: [],
        ended,
      });

      expect(held).toEqual({ _tag: "Held", slugs: ["spilnu"] });
      expect(ended).toEqual(["ended"]);
    }),
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

test("two Runs taking over different claims of one Run both remove theirs from its record", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-handover-" });
      yield* fs.makeDirectory(`${dir}/runs/r-old`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/runs/r-old/helle.json`,
        `[{"slug":"happytiger","claim":"mine"},{"slug":"spilnu","claim":"mine"}]`,
      );
      const takeOver = (slug: string, to: string) =>
        handOverClaim({
          dir,
          slug,
          to,
          runs: ["r-old"],
          stop: (runId) => Effect.succeed({ runs: [runId], left: [] }),
          // Both have read the record before either is done waiting.
          stopped: () => Effect.sleep(20).pipe(Effect.as(true)),
          halt: () => Effect.succeed({ stopped: [], left: [] }),
          patience: { everyMs: 5, forMs: 5_000 },
        });

      yield* Effect.all([takeOver("happytiger", "r-a"), takeOver("spilnu", "r-b")], {
        concurrency: "unbounded",
      });
      expect(yield* fs.exists(`${dir}/runs/r-old/helle.json`)).toBe(false);
    }).pipe(Effect.scoped),
  ));

const RECORDED = `[{"slug":"happytiger","claim":"mine"},{"slug":"spilnu","claim":"mine"}]`;
const SAID = "claim happytiger for the monorepo release";

/**
 * A stopped Run that recorded `happytiger` and `spilnu`, and `slug` claimed for the human
 * through Desktop's Helle tool, its one Machine being this host.
 */
const claimedThroughDesktop = Effect.fn("test.claimedThroughDesktop")(function* (
  prefix: string,
  slug: string,
) {
  const fs = yield* FileSystem.FileSystem;
  fake.projects = [
    { slug: "happytiger", group: "spilnu/frontend", queue: [] },
    { slug: "spilnu", group: "spilnu/frontend", queue: [] },
    { slug: "docs", queue: [] },
  ];
  const { state } = yield* workspace(prefix);
  const host = yield* openHost(state);
  yield* host.ask({
    op: "start",
    id: "stops-on-mr",
    runId: "r1",
    input: { mr: "https://gitlab.example.com/group/project/-/merge_requests/7" },
  });
  yield* host.until({ op: "waiting", runId: "r1" }, (reply) =>
    (reply.diagnostics ?? []).includes("decision"),
  );
  yield* host.ask({ op: "stop", id: "stops-on-mr", runId: "r1" });
  yield* until(
    () => events(state, "r1"),
    (log) => log.includes("stopped"),
  );
  const dir = yield* runDirOf(state, "r1");
  yield* fs.writeFileString(`${dir}/helle.json`, RECORDED);
  const door = chatDoor(yield* frontDoor(socketOf(state)));
  const said = yield* callFlockTool(
    {
      machines: () => [
        {
          name: "vm-mk",
          board: { _tag: "Live", herds: [], tasks: [], protocol: 4, files: true },
          door,
        },
      ],
      conversation: "flock@mk-pc",
      said: () => SAID,
      attachments: () => undefined,
      uploaded: new Map(),
      machineRule: () => undefined,
      setMachineRule: () => Effect.void,
      inSync: () => Effect.succeed(""),
      helle: Effect.succeed({ url: server.base, token: "token-abc" }),
      chatHarness: () => ({ harness: "claude", model: undefined, effort: undefined }),
      chatChoices: Effect.die("not asked"),
      setChatHarness: () => Effect.succeed(null),
    },
    "collie_helle",
    { claim: slug },
  );
  yield* host.stop;
  return { state, dir, runId: dir.split("/").pop()!, said };
});

/** The Run's give-back, as its workflow asks it, against the stand-in Helle. */
const giveBack = (state: string, runId: string) =>
  Effect.gen(function* () {
    const env = yield* envFile();
    return yield* Effect.gen(function* () {
      return yield* (yield* Host).release(runId);
    }).pipe(
      Effect.provide(foundationLayer({ dir: state })),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          HOME: state,
          HELLE_ENV_FILE: env,
          COLLIE_HELLE_URL: server.base,
        }),
      ),
    );
  });

test(
  "a claim through Desktop's Helle tool leaves a stopped Run's record, so its give-back releases none of it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state, dir, runId, said } = yield* claimedThroughDesktop(
          "collie-helle-claimed-",
          "happytiger",
        );
        expect(yield* fs.readFileString(`${dir}/helle.json`)).toBe(
          `[{"slug":"spilnu","claim":"mine"}]`,
        );
        fake.calls = [];
        expect(yield* giveBack(state, runId)).toEqual([]);
        expect(fake.calls).toEqual(["POST /api/v1/projects/spilnu/release"]);
        expect(said).toBe(
          `Claimed happytiger in Helle: you hold it.\nvm-mk:${runId} will no longer give happytiger back.`,
        );
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "a claim of a project no Run recorded changes no Run's record",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state, dir, said } = yield* claimedThroughDesktop(
          "collie-helle-unrecorded-",
          "docs",
        );
        expect(said).toBe("Claimed docs in Helle: you hold it.");
        expect(yield* fs.readFileString(`${dir}/helle.json`)).toBe(RECORDED);
        const asked = yield* readAudit(`${state}/helle`);
        expect(asked.map((line) => [line.operation, line.asked, line.result])).toEqual([
          ["helle_claimed", { slug: "docs" }, []],
        ]);
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "dropping a claim from Runs' records is recorded as the chat that asked, on the host and the Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { state, dir, runId } = yield* claimedThroughDesktop(
          "collie-helle-actor-",
          "happytiger",
        );
        const [onHost] = yield* readAudit(`${state}/helle`);
        expect(onHost).toMatchObject({
          operation: "helle_claimed",
          actor: { origin: "chat", conversation: "flock@mk-pc", said: SAID },
          result: [runId],
        });
        const onRun = (yield* readAudit(dir)).filter((line) => line.operation === "helle_claimed");
        expect(onRun).toEqual([
          {
            ...onHost!,
            at: onRun[0]!.at,
            result: "happytiger",
          },
        ]);
      }).pipe(Effect.scoped),
    ),
  180_000,
);
