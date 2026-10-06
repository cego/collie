// Where Helle always is, and how a token for it is made. Pure, so Desktop shares it.

export const HELLE_URL = "https://helle.cego.dk";

/** Helle's URL, unless `COLLIE_HELLE_URL` points a test at a fake one. */
export const helleUrlOf = (raw: Readonly<Record<string, string | undefined>>) =>
  raw["COLLIE_HELLE_URL"] ?? HELLE_URL;

/** Helle makes tokens only in Slack. */
export const HELLE_TOKEN_STEPS =
  'make a Helle token in Slack: run /helle token, press "Create new token" and label it, for example "Collie"';
