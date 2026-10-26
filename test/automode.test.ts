import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { MrForge } from "../src/board-model";
import { autoModeBlock, autoModeFacts, startedOf, type RunAuthority } from "../src/automode";
import type { Runner } from "../src/mr";
import { runEffect } from "./support/effect";
import { FORGE_HOST, fakeForge, type ForgeModel } from "./support/forge";

const ORIGIN = {
  gitlab: "git@gitlab.example.com:group/app.git",
  github: "git@github.com:owner/repo.git",
} as const;

const SESSION = {
  agent: "run-1-implement-build-r1",
  run: "run-1",
  workflow: "implement",
  machine: "vm-one",
  stateDir: "/state/collie",
  cwd: "/work/app",
};

/** The Run made `branch` in the session's checkout, on the forge's origin. */
const made = (forge: MrForge, branch: string) => ({
  created: { branch, checkout: SESSION.cwd, origin: ORIGIN[forge] },
});

const blockFor = (
  forge: MrForge,
  own: Partial<RunAuthority> = {},
  over: Partial<ForgeModel> = {},
  toplevels: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const fake = fakeForge(forge, {
      installed: true,
      loggedIn: [FORGE_HOST[forge]],
      login: "me",
      mrs: [],
      origin: ORIGIN[forge],
      branch: "me/new-work",
      ...over,
    });
    const run: Runner = (cmd, args, cwd) =>
      args.join(" ") === "rev-parse --show-toplevel"
        ? Effect.succeed({ code: 0, stdout: `${toplevels[cwd] ?? cwd}\n`, stderr: "" })
        : fake.run(cmd, args, cwd);
    const base: RunAuthority = { ...made(forge, "me/new-work"), roaming: false, started: null };
    const facts = yield* autoModeFacts(SESSION, { ...base, ...own }, run).pipe(
      Effect.provide(fake.layer),
    );
    return { block: autoModeBlock(facts), calls: fake.calls };
  });

const HISTORY = "Rewriting history on branch";

test("the block opens each list with the defaults, says entries 1 to 4, and sets no deny list", () =>
  runEffect(
    Effect.gen(function* () {
      const { block } = yield* blockFor("gitlab");
      expect(block.environment[0]).toBe("$defaults");
      expect(block.allow[0]).toBe("$defaults");
      expect(Object.keys(block).toSorted()).toEqual(["allow", "environment"]);
      const [, session, checkout, collie, deliveries] = block.environment;
      expect(session).toContain("agent run-1-implement-build-r1 of Collie Run run-1");
      expect(session).toContain("Workflow implement");
      expect(session).toContain("Machine vm-one");
      expect(checkout).toContain("/work/app");
      expect(checkout).toContain(ORIGIN.gitlab);
      expect(checkout).toContain("branch me/new-work");
      expect(collie).toContain("/state/collie");
      expect(collie).toContain("collie_*");
      expect(deliveries).toContain("collie-delivery:");
      expect(deliveries).toContain("From the human");
      expect(deliveries).toContain("From <agent> of <run>");
    }),
  ));

for (const forge of ["gitlab", "github"] as const) {
  test(`a ${forge} branch the Run created and the forge says is unprotected gets the history allowance`, () =>
    runEffect(
      Effect.gen(function* () {
        const { block } = yield* blockFor(forge);
        const history = block.allow.find((one) => one.startsWith(HISTORY));
        expect(history).toContain("branch me/new-work of");
        expect(history).toContain(ORIGIN[forge]);
        expect(history).toContain("--force-with-lease");
        expect(block.environment[2]).toContain("which this Run created");
        expect(block.environment[2]).not.toContain("protected");
      }),
    ));

  test(`a ${forge} branch the Run created that is the default branch gets no history allowance`, () =>
    runEffect(
      Effect.gen(function* () {
        const { block } = yield* blockFor(forge, made(forge, "main"), {
          branch: "main",
          defaultBranch: "main",
        });
        expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(false);
        expect(block.environment[2]).toContain(
          "which the forge reports protected or could not say",
        );
      }),
    ));

  test(`a ${forge} branch whose protection cannot be read gets no history allowance`, () =>
    runEffect(
      Effect.gen(function* () {
        const { block } = yield* blockFor(forge, {}, { protectionDown: true });
        expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(false);
        expect(block.environment[2]).toContain(
          "which the forge reports protected or could not say",
        );
      }),
    ));
}

test("an origin's embedded credentials never reach the block", () =>
  runEffect(
    Effect.gen(function* () {
      const token = ["glpat", "synthetic0000000000test"].join("-");
      const { block } = yield* blockFor(
        "gitlab",
        {
          created: {
            branch: "me/new-work",
            checkout: SESSION.cwd,
            origin: "https://gitlab.example.com/group/app.git",
          },
        },
        { origin: `https://oauth2:${token}@gitlab.example.com/group/app.git` },
      );
      const text = [...block.environment, ...block.allow].join("\n");
      expect(text).not.toContain(token);
      expect(text).not.toContain("oauth2");
      expect(block.environment[2]).toContain("https://gitlab.example.com/group/app.git");
      expect(block.allow.find((one) => one.startsWith(HISTORY))).toContain(
        "https://gitlab.example.com/group/app.git",
      );
    }),
  ));

test("a created branch a GitLab wildcard rule or a GitHub ruleset matches gets no history allowance", () =>
  runEffect(
    Effect.gen(function* () {
      const gitlab = yield* blockFor("gitlab", made("gitlab", "release/2.0"), {
        branch: "release/2.0",
        protectedBranches: [{ name: "release/*" }],
      });
      const github = yield* blockFor("github", made("github", "release/2.0"), {
        branch: "release/2.0",
        rulesets: ["release/*"],
      });
      for (const { block } of [gitlab, github])
        expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(false);
    }),
  ));

test("a branch the Run was given, as a review's fix agent works on, gets no history allowance and asks no forge", () =>
  runEffect(
    Effect.gen(function* () {
      const { block, calls } = yield* blockFor("gitlab", { created: null });
      expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(false);
      expect(block.environment[2]).toContain("which this Run was given and did not create");
      expect(calls.filter((call) => call.startsWith("glab"))).toEqual([]);
    }),
  ));

test("an agent working another branch than the one its Run created gets no history allowance", () =>
  runEffect(
    Effect.gen(function* () {
      const { block } = yield* blockFor("gitlab", made("gitlab", "me/other"));
      expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(false);
    }),
  ));

test("a branch of the same name in another repository than the Run's checkout gets no history allowance", () =>
  runEffect(
    Effect.gen(function* () {
      const elsewhere = {
        created: { branch: "me/new-work", checkout: "/work/other", origin: ORIGIN.gitlab },
      };
      const { block } = yield* blockFor("gitlab", elsewhere);
      expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(false);
      expect(block.environment[2]).toContain("which this Run was given and did not create");
    }),
  ));

test("a subdirectory of the Run's checkout keeps the history allowance", () =>
  runEffect(
    Effect.gen(function* () {
      const { block } = yield* blockFor(
        "gitlab",
        { created: { branch: "me/new-work", checkout: "/work", origin: ORIGIN.gitlab } },
        {},
        { "/work/app": "/work" },
      );
      expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(true);
    }),
  ));

test("a checkout whose origin was retargeted since the Run made its branch gets no history allowance", () =>
  runEffect(
    Effect.gen(function* () {
      const { block } = yield* blockFor(
        "gitlab",
        {},
        { origin: "git@gitlab.example.com:other/app.git" },
      );
      expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(false);
      expect(block.environment[2]).toContain("which this Run was given and did not create");
    }),
  ));

test("a roaming Run's checkout is detached at the default branch and gets no history allowance", () =>
  runEffect(
    Effect.gen(function* () {
      const { block } = yield* blockFor(
        "gitlab",
        { created: null, roaming: true },
        { branch: "HEAD" },
      );
      expect(block.environment[2]).toContain("detached at the default branch");
      expect(block.allow.some((one) => one.startsWith(HISTORY))).toBe(false);
    }),
  ));

test("a human's starting words are quoted with their door, scrubbed, and cut at 2,000 characters", () =>
  runEffect(
    Effect.gen(function* () {
      const secret = ["glpat", "synthetic0000000000test"].join("-");
      const { block } = yield* blockFor("gitlab", {
        started: { door: "board", words: `Fix the login form with ${secret}` },
      });
      const request = block.environment.find((one) => one.startsWith("The user started"));
      expect(request).toStartWith(
        'The user started this Run from the board with: "Fix the login form',
      );
      expect(request).not.toContain(secret);
      expect(block.allow.some((one) => one.includes("starting words"))).toBe(true);

      const long = yield* blockFor("gitlab", {
        started: { door: "chat", words: "x".repeat(2_500) },
      });
      const cut = long.block.environment.find((one) => one.startsWith("The user started"));
      expect(cut).toContain("x".repeat(2_000));
      expect(cut).not.toContain("x".repeat(2_001));
      expect(cut).toContain("cut at 2,000 characters");
    }),
  ));

test("a Run no human started has no request entry and no intent allowance", () =>
  runEffect(
    Effect.gen(function* () {
      const { block } = yield* blockFor("gitlab", { started: null });
      expect(block.environment.some((one) => one.startsWith("The user started"))).toBe(false);
      expect(block.allow.some((one) => one.includes("starting words"))).toBe(false);
    }),
  ));

test("only a human door or chat starts a Run with words: an agent, a Schedule or a script does not", () => {
  const input = { work: "Fix the login form", retries: 2 };
  expect(startedOf("desktop", undefined, input, { note: "as typed" })).toEqual({
    door: "desktop",
    words: "as typed\nFix the login form",
  });
  expect(startedOf("chat", "fix login please", input, undefined)).toEqual({
    door: "chat",
    words: "fix login please",
  });
  for (const origin of ["agent", "schedule", "cli", "driver", "host"])
    expect(startedOf(origin, "said", input, undefined)).toBeUndefined();
});
