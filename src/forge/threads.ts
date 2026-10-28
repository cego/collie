import { Effect, Schema } from "effect";
import type { RepoRef, Thread, ThreadRef } from "forges";
import { ForgeHttp, type ForgeLogin } from "./http";
import { Issue } from "./issues";
import { mrWords, type MrRef } from "../board-model";

const threadRepo = (login: ForgeLogin, project: string): RepoRef => {
  const path = project.slice(login.host.length + 1);
  const slash = path.lastIndexOf("/");
  return {
    forge: login.forge,
    instance: login.host,
    owner: path.slice(0, slash),
    name: path.slice(slash + 1),
  };
};

const issueOf = (thread: Thread) =>
  Schema.decodeUnknownSync(Issue)({
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
        .then((user) => Schema.decodeUnknownSync(Schema.String)(user.login)),
    );
    return me.ok && me.value.trim() !== "" ? me.value : null;
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
            numbers.map((number) =>
              provider.threads.get(threadRef(login, project, String(number), "issue"), { signal }),
            ),
          )
      ).then((threads) => threads.map(issueOf)),
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
  approve: boolean,
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
    if (!approve) return { ok: true, message: `posted the review to ${where}` };
    const approved = yield* http.ask(login, cwd, (provider, signal) =>
      provider.threads.approve(thread, undefined, { signal }),
    );
    return {
      ok: true,
      message: approved.ok
        ? `posted the review to ${where} and approved it`
        : `posted the review to ${where} and did not approve it: ${approved.reason}; inspect the merge request before approving again, since the approval may have landed`,
    };
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
    return [...seen].map(([iid, title]) => ({ iid, title }));
  });
