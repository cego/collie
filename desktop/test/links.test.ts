// The web links a Run produced, as the record's cards show them.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { mrHeading, mrTab, shortUrl, webLinks } from "../src/shared/links";

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

test("a pipeline's own page is its card, and a page that only starts with digits is a link", () => {
  expect(
    webLinks({
      texts: [
        "https://gitlab.cego.dk/g/p/-/pipelines/90/failures https://gitlab.cego.dk/g/p/-/pipelines/90x",
      ],
      mr: null,
    }),
  ).toEqual([
    {
      kind: "pipeline",
      url: "https://gitlab.cego.dk/g/p/-/pipelines/90/failures",
      title: "Pipeline #90",
    },
    {
      kind: "link",
      url: "https://gitlab.cego.dk/g/p/-/pipelines/90x",
      title: "gitlab.cego.dk/g/p/-/pipelines/90x",
    },
  ]);
});

test("a URL is drawn without its scheme or a trailing slash, and elided in the middle past 60", () => {
  const sixty = `${pipe("a", Str.repeat(57))}.dk`;
  expect(shortUrl(`https://${sixty}`)).toBe(sixty);
  expect(shortUrl(`https://${sixty}/`)).toBe(sixty);
  expect(shortUrl(`http://${pipe("b", Str.repeat(58))}.dk`)).toBe(
    `${pipe("b", Str.repeat(40))}…${pipe("b", Str.repeat(12))}.dk`,
  );
  expect(shortUrl("http://example.com/")).toBe("example.com");
});

test("a merge request or pull request named in an Output is an mr card", () => {
  expect(
    Arr.map(
      webLinks({
        texts: [
          "Opened https://github.com/cego/collie/pull/30 and https://gitlab.cego.dk/cego/app/-/merge_requests/7",
        ],
        mr: null,
      }),
      (card) => card.kind,
    ),
  ).toEqual(["mr", "mr"]);
});

test("a pull request's card is titled #30 and its merge request's !7", () => {
  expect(
    Arr.map(
      webLinks({
        texts: [
          "Opened https://github.com/cego/collie/pull/30 and https://gitlab.cego.dk/cego/app/-/merge_requests/7",
        ],
        mr: null,
      }),
      (card) => card.title,
    ),
  ).toEqual(["#30", "!7"]);
});

test("a pull request's checks are its card's and its panel's, as a merge request's pipeline is", () => {
  const pull = {
    ...mr,
    project: "github.com/cego/collie",
    iid: "30",
    url: "https://github.com/cego/collie/pull/30",
  };
  expect(webLinks({ texts: [], mr: pull }).at(-1)).toMatchObject({
    kind: "pipeline",
    url: "https://github.com/cego/collie/pull/30/checks",
    title: "Checks of #30",
  });
  expect(mrHeading(pull)).toEqual({ title: "#30", checks: "Checks" });
  expect(mrHeading({ project: "gitlab.cego.dk/cego/app", iid: "7" })).toEqual({
    title: "!7",
    checks: "Pipeline",
  });
});

test("a Run's record calls its tab what the forge calls the merge request", () => {
  expect(mrTab("https://github.com/cego/collie/pull/30")).toBe("Pull request");
  expect(mrTab("https://gitlab.cego.dk/cego/app/-/merge_requests/7")).toBe("Merge request");
  expect(mrTab(null)).toBe("Merge request");
});
