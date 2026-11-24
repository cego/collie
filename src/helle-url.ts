export const HELLE_URL = "https://helle.cego.dk";

export const helleUrlOf = (raw: Readonly<Record<string, string | undefined>>) =>
  raw["COLLIE_HELLE_URL"] ?? HELLE_URL;

export const HELLE_TOKEN_STEPS =
  'make a Helle token in Slack: run /helle token, press "Create new token" and label it, for example "Collie"';
