// The web links a Run produced, as the drawer's cards show them.

import { expect, test } from "bun:test";
import { webLinks } from "../src/shared/links";

const mr = {
  _tag: "Details",
  iid: "151",
  project: "cego/collie",
  title: "Drawer",
  state: "opened",
  author: "mk",
  assignees: [],
  sourceBranch: "mk/drawer",
  targetBranch: "master",
  pipeline: "running",
  approvals: "none yet",
  unresolved: false,
  notes: 0,
  headSha: "abcdef0",
  mergedSha: "",
  updatedAt: 0,
  url: "https://gitlab.cego.dk/cego/collie/-/merge_requests/151",
} as const;

test("a markdown link is a card titled by its text, a bare one by where it goes", () => {
  expect(
    webLinks({
      texts: [
        "See [the dashboard](https://kibana.cego.dk/app/dash/1), and https://www.figma.com/file/abc/Drawer.",
      ],
      mr: null,
    }),
  ).toEqual([
    { kind: "link", url: "https://kibana.cego.dk/app/dash/1", title: "the dashboard" },
    {
      kind: "link",
      url: "https://www.figma.com/file/abc/Drawer",
      title: "www.figma.com/file/abc/Drawer",
    },
  ]);
});

test("a link named twice is one card, and keeps the title it was given", () => {
  expect(
    webLinks({
      texts: [
        '{"url":"https://claude.ai/artifact/123"}',
        "[Plan sketch](https://claude.ai/artifact/123)",
      ],
      mr: null,
    }),
  ).toEqual([{ kind: "artifact", url: "https://claude.ai/artifact/123", title: "Plan sketch" }]);
});

test("a link in an Output's JSON ends where its string does", () => {
  expect(
    webLinks({
      texts: ['{"notes":"Saw https://kibana.cego.dk/app/1\\nthen \\"https://x.dk/2\\""}'],
      mr: null,
    }),
  ).toEqual([
    { kind: "link", url: "https://kibana.cego.dk/app/1", title: "kibana.cego.dk/app/1" },
    { kind: "link", url: "https://x.dk/2", title: "x.dk/2" },
  ]);
});

test("an artifact with no title of its own is called one", () => {
  expect(webLinks({ texts: ["https://claude.ai/code/artifact/9f0e"], mr: null })).toEqual([
    { kind: "artifact", url: "https://claude.ai/code/artifact/9f0e", title: "Claude artifact" },
  ]);
});

test("the merge request is a card with its title, and its head pipeline one with its status", () => {
  expect(
    webLinks({
      texts: [`Opened ${mr.url}`, "Pipeline: https://gitlab.cego.dk/cego/collie/-/pipelines/77"],
      mr,
    }),
  ).toEqual([
    { kind: "mr", url: mr.url, title: "Drawer", status: "opened" },
    {
      kind: "pipeline",
      url: "https://gitlab.cego.dk/cego/collie/-/pipelines/77",
      title: "Pipeline #77",
    },
    { kind: "pipeline", url: `${mr.url}/pipelines`, title: "Pipeline of !151", status: "running" },
  ]);
});

test("a merge request with no pipeline has no pipeline card", () => {
  expect(webLinks({ texts: [], mr: { ...mr, pipeline: "" } })).toEqual([
    { kind: "mr", url: mr.url, title: "Drawer", status: "opened" },
  ]);
});

test("the merge request's pipelines named in a Run's text are still one card", () => {
  expect(webLinks({ texts: [`${mr.url}/pipelines`], mr })).toEqual([
    { kind: "pipeline", url: `${mr.url}/pipelines`, title: "Pipeline of !151", status: "running" },
    { kind: "mr", url: mr.url, title: "Drawer", status: "opened" },
  ]);
});
