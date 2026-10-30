// The doctor's GitLab checks: glab and its login, the token's expiry, and whether this
// Machine can push to the Flock's GitLab. They run glab, so they live beside its adapter.

import { hostname } from "node:os";
import { Clock, Effect, Option, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { gitlabHostOf, readConfig } from "../config";
import {
  FETCH_LIMIT,
  answered,
  failed,
  jsonIn,
  noted,
  onPath,
  passed,
  warned,
  type Check,
} from "../doctor-check";
import type { PluginEnv } from "../env";
import { daysLeft, isHostName, RENEW_WITHIN_DAYS, TokenSelf, tokenPage } from "../gitlab-token";
import { whatItSaid, type Runner } from "../mr";
import { shellQuote } from "../script";
import { glabLoginTo } from "./gitlab";
import { isString } from "../schema";
import type { ConnectionReading as Probe } from "../connection-model";

export const glabLoginOn = Effect.fn("GitLab.loginOn")(function* <R>(
  env: PluginEnv,
  run: Runner<R>,
) {
  const config = yield* readConfig(env.userDir);
  const configured = env.raw.GITLAB_HOST ?? config.gitlab_host;
  const stored =
    isString(configured) && isHostName(configured)
      ? configured
      : (yield* run("glab", ["config", "get", "host", "--global"], env.cwd)).stdout.trim();
  const host = isHostName(stored) ? stored : "gitlab.com";
  return glabLoginTo(host);
});

const GitlabUser = Schema.fromJsonString(Schema.Struct({ username: Schema.NonEmptyString }));

export const probeGitlab = Effect.fn("Connections.probeGitlab")(function* <R>(
  env: PluginEnv,
  run: Runner<R>,
) {
  const login = yield* glabLoginOn(env, run);
  const host = login.host;
  const fix = login.relogin;
  const environmentToken =
    env.raw.GITLAB_TOKEN || env.raw.GITLAB_ACCESS_TOKEN || env.raw.OAUTH_TOKEN;
  const storedToken = environmentToken ? null : yield* login.token(run, env.cwd);
  const token = environmentToken || (storedToken ?? "");
  if (token === "")
    return { state: "absent", detail: `no GitLab login for ${host}`, fix } satisfies Probe;
  const args = ["api", "--hostname", host, "user"];
  const me = yield* environmentToken
    ? run("env", [`GITLAB_HOST=${host}`, "glab", ...args], env.cwd)
    : run("glab", args, env.cwd);
  const user = Schema.decodeUnknownOption(GitlabUser)(me.stdout);
  if (me.code !== 0 || Option.isNone(user))
    return {
      state: "broken",
      detail: `${host} did not accept its GitLab login`,
      fix,
    } satisfies Probe;
  return {
    state: "ok",
    account: user.value.username,
    detail: `${host} as ${user.value.username}`,
  } satisfies Probe;
});

/**
 * Each host `glab auth status` names (its unindented lines), and whether git reaches it
 * over HTTPS. Read whatever the exit code: one host with a bad token fails the command
 * for all of them.
 */
export const glabHosts = (status: string) =>
  status
    .split("\n")
    .filter((line) => /^[a-z0-9.-]+(:\d+)?$/i.test(line))
    .map((host) => ({
      host,
      https: status.includes(`Git operations for ${host} configured to use https protocol`),
    }));

const tokenExpiry = Effect.fn("Doctor.tokenExpiry")(function* (
  host: string,
  root: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const renew = `make a token at ${tokenPage(host)}, then glab auth login --hostname ${host} --stdin`;
  const answer = yield* answered(
    run("glab", ["api", "--hostname", host, "personal_access_tokens/self"], root),
  );
  const token = Schema.decodeUnknownOption(TokenSelf)(jsonIn(answer.stdout));
  if (answer.code !== 0 || Option.isNone(token)) {
    return warned(`${host} would not say when its token expires`, renew);
  }
  const expires = token.value.expires_at;
  if (expires === null) return passed(`${host}: the token never expires`);
  const days = daysLeft(expires, yield* Clock.currentTimeMillis);
  if (days < 0) return failed(`${host}: the token expired on ${expires}`, renew);
  if (days < RENEW_WITHIN_DAYS) return warned(`${host}: the token expires on ${expires}`, renew);
  return passed(`${host}: the token expires on ${expires}`);
});

/** An agent sshd forwarded into this session, which goes when the computer it came from sleeps. */
const FORWARDED_AGENT = /^\/tmp\/ssh-[^/]+\/agent\.\d+$/;

/** Whether this Machine's own keys reach `host` over SSH, or glab's token over HTTPS. */
export const pushCheck = Effect.fn("Doctor.pushCheck")(function* (
  host: { host: string; https: boolean },
  env: PluginEnv,
  ssh: boolean,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  if (host.https) return passed(`pushes to ${host.host} over HTTPS with glab's token`);
  if (!ssh) return failed("no ssh on PATH", "install the OpenSSH client");
  const forwarded = FORWARDED_AGENT.test(env.raw["SSH_AUTH_SOCK"] ?? "");
  const args = ["-oBatchMode=yes", "-oConnectTimeout=5", "-T"];
  if (forwarded) args.push("-oIdentityAgent=none");
  const answer = yield* answered(run("ssh", [...args, `git@${host.host}`], env.pluginRoot));
  if (answer.code === 0) return passed(`pushes to ${host.host} with this Machine's own key`);
  if (answer.code === 124)
    return failed(`${host.host} did not answer within ${FETCH_LIMIT}`, `ssh -T git@${host.host}`);
  if (whatItSaid(answer).includes("Host key verification failed")) {
    return failed(
      `${host.host}'s host key is not known here`,
      `ssh-keyscan ${host.host} >> ~/.ssh/known_hosts`,
    );
  }
  return failed(
    `cannot push to ${host.host}${forwarded ? " without the forwarded SSH agent" : ""}`,
    `[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519; GITLAB_HOST=${host.host} glab ssh-key add ~/.ssh/id_ed25519.pub --title ${shellQuote(hostname())}`,
  );
});

/** Every GitLab check, exactly as `collie doctor` has always made them. */
export const gitlabChecks = Effect.fn("Doctor.gitlabChecks")(function* (
  env: PluginEnv,
  search: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const root = env.pluginRoot;
  const checks: Check[] = [];
  const glabDir = yield* onPath(search, "glab");
  const host = yield* gitlabHostOf(env);
  // The whole status only names the other hosts: one with a bad token fails it for all.
  const [auth, everyHost] = glabDir
    ? yield* Effect.all(
        [
          answered(run("glab", ["auth", "status", "--hostname", host], root)),
          answered(run("glab", ["auth", "status"], root)),
        ],
        { concurrency: "unbounded" },
      )
    : [null, null];
  checks.push({
    name: "glab",
    ...(!glabDir
      ? failed(
          "not installed; the workflows that open or review a merge request will not work",
          "install glab — https://gitlab.com/gitlab-org/cli",
        )
      : auth?.code === 0
        ? passed(`logged in to ${host}`)
        : auth?.code === 124
          ? failed(
              `installed, but did not answer within ${FETCH_LIMIT}`,
              `glab auth status --hostname ${host}`,
            )
          : failed(
              `installed, but not logged in to ${host}`,
              `glab auth login --hostname ${host}`,
            )),
  });

  // A host glab has never heard of is the `glab` check's failure, not two more.
  const known = auth ? glabHosts(whatItSaid(auth)).find((one) => one.host === host) : undefined;
  if (known !== undefined || auth?.code === 0) {
    const ssh = (yield* onPath(search, "ssh")) !== null;
    checks.push({ name: "gitlab token", ...(yield* tokenExpiry(host, root, run)) });
    checks.push({
      name: "git push",
      ...(yield* pushCheck(known ?? { host, https: false }, env, ssh, run)),
    });
  }
  const others = everyHost
    ? glabHosts(whatItSaid(everyHost)).filter((one) => one.host !== host)
    : [];
  if (others.length > 0) {
    checks.push({
      name: "other gitlabs",
      ...noted(
        `${others.map((one) => one.host).join(", ")}: glab knows ${others.length === 1 ? "it" : "them"}, and only ${host} is checked`,
        "",
      ),
    });
  }

  return checks;
});
