import * as Arr from "effect/Array";
import { Schema } from "effect";
import { epochMs } from "./time";

export const GITLAB_HOST = "gitlab.cego.dk";

export const isHostName = (value: string) =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(value);

export const SCOPES = ["api", "write_repository"];

export const tokenPage = (host: string) =>
  `https://${host}/-/user_settings/personal_access_tokens?name=Collie&scopes=${Arr.join(SCOPES, ",")}`;

export const RENEW_WITHIN_DAYS = 14;
const DAY_MS = 86_400_000;

export const daysLeft = (expires: string, now: number) =>
  Math.floor((epochMs(expires) - now) / DAY_MS);

export const renewalDue = (expires: string | null, now: number) =>
  expires !== null && daysLeft(expires, now) < RENEW_WITHIN_DAYS;

export const TokenSelf = Schema.fromJsonString(
  Schema.Struct({
    expires_at: Schema.NullOr(Schema.String),
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
