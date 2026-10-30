import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import {
  connectionCards,
  connectionUses,
  mergeConnections,
  workflowConnections,
} from "../desktop/src/shared/connections";
import { Effect, FileSystem } from "effect";
import { hosted } from "./support/hosted";
import { readDefinitions } from "../src/authoring";
import { tokenPage } from "../src/gitlab-token";

test("the token page uses the configured GitLab with Collie and both scopes prefilled", () => {
  expect(tokenPage("gitlab.example.org:8443")).toBe(
    "https://gitlab.example.org:8443/-/user_settings/personal_access_tokens?name=Collie&scopes=api,write_repository",
  );
});

test(
  "Connection tables use the shipped declarations, including needs and local fallbacks",
  () =>
    hosted("desktop-connection-declarations-", ({ world, env }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.copy(
          new URL("../workflows", import.meta.url).pathname,
          `${world.install}/workflows`,
        );
        const definitions = yield* readDefinitions(env);
        const workflows = workflowConnections(definitions.workflows);
        const gitlab = connectionUses("gitlab", workflows);
        expect(Option.getOrUndefined(Arr.findFirst(gitlab, (row) => row.id === "review"))).toEqual({
          id: "review",
          declares: "uses",
          with: "Reads and answers the merge request",
          without: "Reviews the local diff only",
        });
        expect(Arr.some(gitlab, (row) => row.id === "plan")).toBe(false);
        expect(definitions.connectionUses).toEqual([
          {
            id: "Notifications",
            connections: {
              uses: { slack: { with: "Posts the toasts you keep on", without: "Toasts only" } },
            },
          },
        ]);
        expect(
          Option.getOrUndefined(
            Arr.findFirst(connectionUses("helle", workflows), (row) => row.id === "release"),
          ),
        ).toMatchObject({ declares: "needs", without: "Does not start" });
      }),
    ),
  30_000,
);

test("a GitLab card offers one login to both lacking Machines and no action once all have it", () => {
  const readings = [
    {
      profile: "p-pc",
      name: "pc",
      connections: [
        {
          id: "gitlab" as const,
          reading: { state: "ok" as const, account: "mk", detail: "gitlab.example as mk" },
        },
      ],
      workflows: [],
      problem: null,
    },
    ...Arr.map(["vm", "mini"], (name) => ({
      profile: `p-${name}`,
      name,
      connections: [
        {
          id: "gitlab" as const,
          reading: { state: "absent" as const, detail: "no login", fix: "glab auth login" },
        },
      ],
      workflows: [],
      problem: null,
    })),
  ];
  const card = Option.getOrUndefined(
    Arr.findFirst(connectionCards(readings), ({ id }) => id === "gitlab"),
  )!;
  expect(card.primary).toEqual({
    kind: "reuse",
    label: "Use glab's login",
    from: "p-pc",
    to: ["p-vm", "p-mini"],
  });
  expect(card.where).toBe("On pc · missing on vm and mini");
  expect(card.needsYou).toBe(true);
  const complete = connectionCards(
    Arr.map(readings, (row) => ({ ...row, connections: readings[0]!.connections })),
  );
  expect(
    Option.getOrUndefined(Arr.findFirst(complete, ({ id }) => id === "gitlab"))!.primary,
  ).toBeNull();
  expect(
    Option.getOrUndefined(Arr.findFirst(complete, ({ id }) => id === "gitlab"))!.needsYou,
  ).toBe(false);
});

test("browser setup names the one Machine it starts on, then the next after refresh", () => {
  const machines = Arr.map(["vm", "mini"], (name) => ({
    profile: `p-${name}`,
    name,
    connections: [],
    workflows: [],
    problem: null,
  }));
  expect(
    Option.getOrUndefined(Arr.findFirst(connectionCards(machines), (card) => card.id === "linear"))!
      .primary,
  ).toEqual({
    kind: "setup",
    label: "Set up on vm",
    to: ["p-vm"],
  });
  expect(
    Option.getOrUndefined(Arr.findFirst(connectionCards(machines), (card) => card.id === "github"))!
      .primary,
  ).toEqual({
    kind: "login",
    label: "Sign in on vm",
    to: ["p-vm"],
  });
  expect(
    Option.getOrUndefined(
      Arr.findFirst(
        connectionCards(
          Arr.map(machines, (machine, i) => ({
            ...machine,
            connections:
              i === 0
                ? [
                    {
                      id: "linear",
                      reading: { state: "ok", account: "linear-server", detail: "connected" },
                    },
                  ]
                : [],
          })),
        ),
        (card) => card.id === "linear",
      ),
    )!.primary,
  ).toMatchObject({ label: "Set up on mini", to: ["p-mini"] });
});

test("the Flock offers the Machine with a working GitLab login to the Machine that lacks one", () => {
  const lacking = { state: "absent" as const, detail: "no token", fix: "glab auth login" };
  const merged = mergeConnections([
    {
      machine: "mk-pc",
      connections: [
        { id: "gitlab", reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" } },
      ],
    },
    { machine: "vm-mk", connections: [{ id: "gitlab", reading: lacking }] },
  ]);
  expect(merged).toEqual([
    {
      id: "gitlab",
      state: "ok",
      account: "mk",
      fix: null,
      machines: [
        {
          machine: "mk-pc",
          reading: { state: "ok", account: "mk", detail: "gitlab.example as mk" },
        },
        { machine: "vm-mk", reading: { ...lacking, reusable: { from: "mk-pc" } } },
      ],
    },
  ]);
  expect(lacking).not.toHaveProperty("reusable");
  expect(
    mergeConnections([{ machine: "vm-mk", connections: [{ id: "gitlab", reading: lacking }] }]),
  ).toMatchObject([{ state: "absent", account: null, fix: "glab auth login" }]);
});
