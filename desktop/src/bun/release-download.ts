// Desktop updates come from Collie's public GitHub releases. A redirect may hand an
// asset to GitHub's CDN, but must never turn an update into a request to another service.
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

const allowed = (url: URL, redirected: boolean) =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.port === "" &&
  url.hash === "" &&
  ((url.hostname === "github.com" &&
    url.search === "" &&
    /^\/cego\/collie\/releases\/(?:latest\/download|download\/\d+\.\d+\.\d+)\/stable-[\w.-]+$/.test(
      url.pathname,
    )) ||
    (redirected &&
      (url.hostname === "release-assets.githubusercontent.com" ||
        url.hostname === "objects.githubusercontent.com")));

export const downloadRelease = (source: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let url = yield* Effect.try({ try: () => new URL(source), catch: String });
    for (let hop = 0; hop <= 5; hop++) {
      if (!allowed(url, hop > 0))
        return yield* Effect.fail("the update URL is not a Collie release");
      const response: HttpClientResponse.HttpClientResponse = yield* client
        .get(url.href)
        .pipe(
          Effect.mapError(String),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (location === undefined)
          return yield* Effect.fail("the update redirect has no location");
        url = yield* Effect.try({ try: () => new URL(location, url), catch: String });
        continue;
      }
      if (response.status !== 200)
        return yield* Effect.fail(`the update download answered ${response.status}`);
      return response;
    }
    return yield* Effect.fail("the update download redirected too many times");
  });
