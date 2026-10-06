// The one GitLab token a Machine pushes and asks GitLab with: where it is made, and when it
// is due to be renewed. Pure, so Desktop shares it with doctor.

import { Schema } from "effect";
import { epochMs } from "./time";

export const GITLAB_HOST = "gitlab.cego.dk";

/** A host as glab names one: DNS labels, and a port where it has one. */
export const isHostName = (value: string) =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(value);

/** What the token must be allowed: the API, and pushing. */
export const SCOPES = ["api", "write_repository"];

/** GitLab's page for a new token, with its name and the scopes Collie needs filled in. */
export const tokenPage = (host: string) =>
  `https://${host}/-/user_settings/personal_access_tokens?name=collie&scopes=${SCOPES.join(",")}`;

export const RENEW_WITHIN_DAYS = 14;
const DAY_MS = 86_400_000;

/** Whole days from `now` until `expires`, a date as GitLab gives it; negative once it passed. */
export const daysLeft = (expires: string, now: number) =>
  Math.floor((epochMs(expires) - now) / DAY_MS);

/** Whether a token expiring on `expires` is due for renewal at `now`. */
export const renewalDue = (expires: string | null, now: number) =>
  expires !== null && daysLeft(expires, now) < RENEW_WITHIN_DAYS;

/** What GitLab says of the token it is asked with, at `personal_access_tokens/self`. */
export const TokenSelf = Schema.fromJsonString(
  Schema.Struct({
    expires_at: Schema.NullOr(Schema.String),
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
