import { expect, test } from "bun:test";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { downloadRelease } from "../desktop/src/bun/release-download";
import { runEffect } from "./support/effect";

const ASSET =
  "https://github.com/cego/collie/releases/latest/download/stable-linux-x64-update.json";
const TAGGED =
  "https://github.com/cego/collie/releases/download/1.0.0/stable-linux-x64-update.json";
const CDN =
  "https://release-assets.githubusercontent.com/github-production-release-asset/123?sig=example";

const transport = (respond: (url: string) => Response) =>
  HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request.url))),
  );

test("desktop updates follow Collie's release redirect and GitHub's asset CDN", () =>
  runEffect(
    Effect.gen(function* () {
      const seen: string[] = [];
      const client = transport((url) => {
        seen.push(url);
        if (url === ASSET) return Response.redirect(TAGGED);
        if (url === TAGGED) return Response.redirect(CDN);
        return new Response("signed bytes");
      });
      const body = yield* downloadRelease(ASSET).pipe(
        Effect.flatMap((response) => response.text),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(body).toBe("signed bytes");
      expect(seen).toEqual([ASSET, TAGGED, CDN]);
    }),
  ));

test("an update URL cannot request another origin, repository or protocol", () =>
  runEffect(
    Effect.gen(function* () {
      const seen: string[] = [];
      const client = transport((url) => {
        seen.push(url);
        return new Response("unexpected");
      });
      for (const url of [
        "http://localhost:8080/update",
        "https://127.0.0.1/update",
        "https://[::1]/update",
        "https://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
        "https://github.com.evil.test/cego/collie/releases/latest/download/stable-app",
        "https://github.com/other/collie/releases/latest/download/stable-app",
        "https://github.com/cego/collie/releases/download/..%2f..%2fapi/stable-app",
        "https://user:password@github.com/cego/collie/releases/latest/download/stable-app",
        "https://github.com:8443/cego/collie/releases/latest/download/stable-app",
        `${ASSET}?url=http://localhost`,
        CDN,
      ]) {
        const result = yield* downloadRelease(url).pipe(
          Effect.flip,
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(result).toContain("not a Collie release");
      }
      expect(seen).toEqual([]);
    }),
  ));

test("every redirect is validated and a redirect loop is bounded", () =>
  runEffect(
    Effect.gen(function* () {
      for (const destination of [
        "http://127.0.0.1/secret",
        "https://evil.test/asset",
        "https://github.com/other/repo/asset",
      ]) {
        const seen: string[] = [];
        const client = transport((url) => {
          seen.push(url);
          return Response.redirect(destination);
        });
        expect(
          yield* downloadRelease(ASSET).pipe(
            Effect.flip,
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        ).toContain("not a Collie release");
        expect(seen).toEqual([ASSET]);
      }
      let requests = 0;
      const client = transport(() => {
        requests++;
        return Response.redirect(ASSET);
      });
      expect(
        yield* downloadRelease(ASSET).pipe(
          Effect.flip,
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      ).toContain("too many times");
      expect(requests).toBe(6);
    }),
  ));
