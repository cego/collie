import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { Effect, Schema, flow, Result } from "effect";
import type { RepoRef, Thread, ThreadRef } from "forges";
import { ForgeHttp, pagesAs, request, type ForgeLogin } from "./http";
import { Issue } from "./issues";
import { mrWords, type MrRef } from "../board-model";

const threadRepo = (login: ForgeLogin, project: string): RepoRef => {
  const path = pipe(project, Str.slice(login.host.length + 1));
  const slash = Option.getOrElse(pipe(path, Str.lastIndexOf("/")), () => -1);
  return {
    forge: login.forge,
    instance: login.host,
    owner: pipe(path, Str.slice(0, slash)),
    name: pipe(path, Str.slice(slash + 1)),
  };
};

const issueOf = (thread: Thread) =>
  flow(
    Schema.decodeUnknownResult(Issue),
    Result.getOrThrow,
  )({
    number: Number(thread.ref.number),
    title: thread.title,
    body: thread.body ?? "",
    url: thread.url,
  });

export const viewerLogin = (login: ForgeLogin, cwd: string) =>
  Effect.gen(function* () {
    const http = yield* ForgeHttp;
    const me = yield* http.ask(login, cwd, (provider, signal) =>
      provider.users
        .me({ signal })
        .then((user) => flow(Schema.decodeResult(Schema.String), Result.getOrThrow)(user.login)),
    );
    return me.ok && Str.trim(me.value) !== "" ? me.value : null;
  });

export const listIssues = (
  login: ForgeLogin,
  project: string,
  cwd: string,
  numbers?: ReadonlyArray<number>,
) =>
  Effect.gen(function* () {
    const http = yield* ForgeHttp;
    const listed = yield* http.ask(login, cwd, (provider, signal) =>
      (numbers === undefined
        ? Array.fromAsync(
            provider.threads.list(threadRepo(login, project), {
              kind: "issue",
              state: "open",
              perPage: 100,
              signal,
            }),
          )
        : Promise.all(
            Arr.map(numbers, (number) =>
              provider.threads.get(threadRef(login, project, String(number), "issue"), { signal }),
            ),
          )
      ).then((threads) => Arr.map(threads, issueOf)),
    );
    return listed.ok ? { ok: true as const, issues: listed.value } : listed;
  });

export const createIssue = (
  login: ForgeLogin,
  project: string,
  title: string,
  body: string,
  cwd: string,
) =>
  Effect.gen(function* () {
    const http = yield* ForgeHttp;
    const filed = yield* http.ask(login, cwd, (provider, signal) =>
      provider.threads
        .create(threadRepo(login, project), { kind: "issue", title, body }, { signal })
        .then(issueOf),
    );
    return filed.ok
      ? { ok: true as const, number: filed.value.number, url: filed.value.url }
      : {
          ok: false as const,
          reason: `${filed.reason}; inspect the repository's issues before retrying`,
        };
  });

const threadRef = (
  login: ForgeLogin,
  project: string,
  number: string,
  kind: "issue" | "pull_request",
): ThreadRef => ({
  forge: login.forge,
  instance: login.host,
  repo: threadRepo(login, project),
  kind,
  number,
});

export const commentIssue = (
  login: ForgeLogin,
  project: string,
  number: number,
  body: string,
  cwd: string,
) =>
  Effect.gen(function* () {
    const http = yield* ForgeHttp;
    const noted = yield* http.ask(login, cwd, (provider, signal) =>
      provider.threads.createComment(threadRef(login, project, String(number), "issue"), body, {
        signal,
      }),
    );
    return noted.ok
      ? { ok: true, reason: "" }
      : { ok: false, reason: `${noted.reason}; inspect the issue before retrying` };
  });

export const postReview = (
  login: ForgeLogin,
  project: string,
  ref: MrRef,
  body: string,
  cwd: string,
) =>
  Effect.gen(function* () {
    const http = yield* ForgeHttp;
    const thread = threadRef(login, project, ref.iid, "pull_request");
    const where = login.forge === "gitlab" ? `${ref.project ?? ""}!${ref.iid}` : mrWords(ref).label;
    const noted = yield* http.ask(login, cwd, (provider, signal) =>
      provider.threads.createComment(thread, body, { signal }),
    );
    if (!noted.ok)
      return {
        ok: false,
        message: `could not post the review to ${where}: ${noted.reason}; inspect the merge request before retrying`,
      };
    return { ok: true, message: `posted the review to ${where}` };
  });

export const approveReview = (
  login: ForgeLogin,
  project: string,
  ref: MrRef,
  head: string,
  cwd: string,
) =>
  Effect.gen(function* () {
    const where = mrWords(ref).label;
    if (head === "") return { ok: false, message: `did not approve ${where}: no reviewed head` };
    const repo = threadRepo(login, project);
    const path = `${repo.owner}/${repo.name}`;
    const approved = yield* login.forge === "gitlab"
      ? request(
          login,
          cwd,
          "POST",
          `projects/${encodeURIComponent(path)}/merge_requests/${ref.iid}/approve`,
          { sha: head },
        )
      : request(login, cwd, "POST", `repos/${path}/pulls/${ref.iid}/reviews`, {
          event: "APPROVE",
          commit_id: head,
        });
    return approved.ok
      ? { ok: true, message: `approved ${where} at ${head}` }
      : { ok: false, message: `did not approve ${where} at ${head}: ${approved.reason}` };
  });

export const findReviewNote = (
  login: ForgeLogin,
  project: string,
  ref: MrRef,
  signature: string,
  cwd: string,
) =>
  Effect.gen(function* () {
    const repo = threadRepo(login, project);
    const path = `${repo.owner}/${repo.name}`;
    const notes = yield* pagesAs(
      Schema.Struct({ body: Schema.String }),
      login,
      cwd,
      login.forge === "gitlab"
        ? `projects/${encodeURIComponent(path)}/merge_requests/${ref.iid}/notes`
        : `repos/${path}/issues/${ref.iid}/comments`,
    );
    return notes.ok
      ? {
          ok: true as const,
          value: Arr.some(
            notes.value,
            (note) => Str.split(Str.trimEnd(note.body), "\n").at(-1) === signature,
          ),
        }
      : notes;
  });

export const myMergeRequests = (login: ForgeLogin, project: string, cwd: string) =>
  Effect.gen(function* () {
    const me = yield* viewerLogin(login, cwd);
    if (me === null) return [];
    const http = yield* ForgeHttp;
    const seen = new Map<string, string>();
    for (const who of ["assignee", "author"] as const) {
      const listed = yield* http.ask(login, cwd, (provider, signal) =>
        Array.fromAsync(
          provider.threads.list(threadRepo(login, project), {
            kind: "pull_request",
            state: "open",
            [who]: me,
            perPage: 100,
            signal,
          }),
        ),
      );
      if (listed.ok)
        for (const one of listed.value)
          if (one.ref.number !== undefined && !seen.has(one.ref.number))
            seen.set(one.ref.number, one.title ?? "");
    }
    return Arr.map([...seen], ([iid, title]) => ({ iid, title }));
  });
