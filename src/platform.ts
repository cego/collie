import * as BunServices from "@effect/platform-bun/BunServices";
import { Layer } from "effect";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";

export type PlatformServices = BunServices.BunServices | SecureRandom.SecureRandom | Digest.Digest;

export const platformLayer: Layer.Layer<PlatformServices> = Layer.mergeAll(
  BunServices.layer,
  SecureRandom.layerWebCrypto,
  Digest.layerWebCrypto,
);
