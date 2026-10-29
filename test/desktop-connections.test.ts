import { expect, test } from "bun:test";
import { mergeConnections } from "../desktop/src/shared/connections";

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
