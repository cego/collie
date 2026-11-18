import { Schema } from "effect";

export const Issue = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  closedAt: Schema.optionalKey(Schema.String),
});
export type Issue = typeof Issue.Type;
export interface IssueRef {
  readonly number: number;
  readonly url: string;
}
export type IssueList =
  | { readonly ok: true; readonly issues: ReadonlyArray<Issue> }
  | { readonly ok: false; readonly reason: string };
export type FiledIssue =
  | ({ readonly ok: true } & IssueRef)
  | { readonly ok: false; readonly reason: string };
/** Issues by number, or every issue closed at or after an ISO moment. */
export type IssueQuery = ReadonlyArray<number> | { readonly closedSince: string };
