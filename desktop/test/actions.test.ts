import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { actionRunner, type ActionNotice } from "../src/shared/actions";
import { ActionFailed, type DesktopAction } from "../src/shared/flock";
import { clearSent, type Draft, editDraft } from "../src/shared/review-comments";

test("a successful toast retry clears the original sent drafts and preserves later edits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sent: Draft[] = [
        { id: "a", anchor: { _tag: "Plan", file: "SPEC.md", quote: "one" }, text: "first" },
        { id: "b", anchor: { _tag: "Plan", file: "SPEC.md", quote: "two" }, text: "second" },
      ];
      let drafts = sent;
      const calls: Array<{
        installation: string;
        action: DesktopAction;
        request: string | undefined;
      }> = [];
      const notices: ActionNotice[] = [];
      const run = actionRunner(
        ({ payload }) => {
          calls.push(payload);
          return Promise.resolve(
            calls.length === 1
              ? Exit.fail(new ActionFailed({ reason: "connection lost", request: payload.request }))
              : Exit.succeed("Delivered"),
          );
        },
        (notice) => notices.push(notice),
      );
      const action: DesktopAction = {
        _tag: "Deliver",
        runId: "r",
        agent: "planner",
        text: "comments",
      };
      expect(
        yield* Effect.promise(() =>
          run("local", action, undefined, () => {
            drafts = clearSent(drafts, sent);
          }),
        ),
      ).toBe(false);
      expect(drafts).toEqual(sent);
      drafts = [...editDraft(drafts, "b", "edited meanwhile"), { ...sent[0]!, id: "c" }];
      expect(yield* Effect.promise(() => notices[0]!.actions![0]!.onClick())).toBe(true);
      expect(Arr.map(drafts, (draft) => draft.id)).toEqual(["b", "c"]);
      expect(calls[1]).toEqual({ installation: "local", action, request: calls[0]!.request });
    }),
  ));

test("a failure on the view's own channel offers Try again under the request the first call carried", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests: Array<string | undefined> = [];
      const notices: ActionNotice[] = [];
      const run = actionRunner(
        ({ payload }) => {
          requests.push(payload.request);
          return Promise.resolve(
            requests.length === 1
              ? Exit.die(new Error("the view's channel closed"))
              : Exit.succeed("Held r"),
          );
        },
        (notice) => notices.push(notice),
      );
      const action: DesktopAction = { _tag: "Control", runId: "r", control: "hold", set: true };
      expect(yield* Effect.promise(() => run("local", action))).toBe(false);
      expect(yield* Effect.promise(() => notices[0]!.actions![0]!.onClick())).toBe(true);
      expect(requests[0]).toBeString();
      expect(requests[1]).toBe(requests[0]);
    }),
  ));

test("every try, Try again's too, says when it starts and how it ended", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tries: Array<boolean | null> = [];
      const notices: ActionNotice[] = [];
      let calls = 0;
      const run = actionRunner(
        () =>
          Promise.resolve(
            ++calls === 1
              ? Exit.fail(new ActionFailed({ reason: "not confirmed", request: undefined }))
              : Exit.succeed("Answered r"),
          ),
        (notice) => notices.push(notice),
      );
      const action: DesktopAction = { _tag: "Answer", runId: "r", decision: "d", value: "v" };
      yield* Effect.promise(() =>
        run("local", action, undefined, undefined, undefined, (done) => tries.push(done)),
      );
      yield* Effect.promise(() => notices[0]!.actions![0]!.onClick());
      expect(tries).toEqual([null, false, null, true]);
    }),
  ));
