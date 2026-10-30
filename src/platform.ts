import * as BunServices from "@effect/platform-bun/BunServices";
import { Layer } from "effect";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";

/** Bun's services and the crypto Effect 4.1 took out of them, which ids and hashes draw on. */
export type PlatformServices = BunServices.BunServices | SecureRandom.SecureRandom | Digest.Digest;

export const platformLayer: Layer.Layer<PlatformServices> = Layer.mergeAll(
  BunServices.layer,
  SecureRandom.layerWebCrypto,
  Digest.layerWebCrypto,
);
