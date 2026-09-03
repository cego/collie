// Which herdr binary to download, and what it must hash to. Split out of
// `tools/herdr-schema.ts`, which has no seam of its own — its interface is argv, so the
// only way to exercise it is to run the whole thing against the network. Picking the
// wrong checksum out of the wrong manifest shape is how a verification step quietly
// stops verifying, so that choice lives here behind a seam with a test on it.

/** One herdr build to fetch and check. */
export interface Release {
  /** What a failure message should call it: a version, or a preview build id. */
  readonly label: string;
  readonly protocol: number;
  readonly url: string;
  readonly sha256: string;
}

/** `herdr-pin.json`: the version Collie is verified against, with its checksums. */
export interface Pin {
  readonly version: string;
  readonly protocol: number;
  readonly sha256: Readonly<Record<string, string>>;
}

/** `https://herdr.dev/latest.json`: parallel `assets` and `sha256` maps. */
export interface StableManifest {
  readonly version: string;
  readonly protocol: number;
  readonly assets: Readonly<Record<string, string>>;
  readonly sha256: Readonly<Record<string, string>>;
}

/**
 * `https://herdr.dev/preview.json`: url and checksum nested per asset, which is not the
 * shape the stable manifest uses.
 */
export interface PreviewManifest {
  readonly build_id: string;
  readonly protocol: number;
  readonly assets: Readonly<Record<string, { readonly url: string; readonly sha256: string }>>;
}

/** Where the three channels' release facts come from. */
export type Source =
  | { readonly pinned: Pin }
  | { readonly stable: StableManifest }
  | { readonly preview: PreviewManifest };

export const MANIFEST_URLS = {
  stable: "https://herdr.dev/latest.json",
  preview: "https://herdr.dev/preview.json",
} as const;

/**
 * Whether the stable manifest still agrees with the pin about the pinned version, and
 * what is wrong when it does not. The pin's own checksum stays the one the download is
 * verified against — a checksum fetched from the host that also serves the binary
 * cannot attest to it — so this is the cross-check that catches the likelier mistake:
 * the wrong hash committed when bumping the pin. Nothing to say once herdr has moved
 * past the pinned version, which the manifest no longer describes.
 */
export function pinDisagreement(
  pin: Pin,
  stable: StableManifest,
  target: string,
): string | undefined {
  if (stable.version !== pin.version) return undefined;
  const published = stable.sha256[target];
  if (published === undefined) {
    return `the stable manifest names ${pin.version} but records no ${target} checksum`;
  }
  if (published !== pin.sha256[target]) {
    return `herdr-pin.json has ${pin.sha256[target]} for ${target} at ${pin.version}, but the stable manifest publishes ${published}`;
  }
  return undefined;
}

const missing = (what: string, target: string): never => {
  throw new Error(`${what} records no ${target} asset`);
};

export function releaseFrom(source: Source, target: string): Release {
  if ("pinned" in source) {
    const pin = source.pinned;
    return {
      label: pin.version,
      protocol: pin.protocol,
      // A pinned version is not in the stable manifest once herdr has moved on, so the
      // release URL is composed rather than looked up.
      url: `https://github.com/herdrdev/herdr/releases/download/v${pin.version}/herdr-${target}`,
      sha256: pin.sha256[target] ?? missing("herdr-pin.json", target),
    };
  }
  if ("stable" in source) {
    const latest = source.stable;
    return {
      label: latest.version,
      protocol: latest.protocol,
      url: latest.assets[target] ?? missing("the stable manifest", target),
      sha256: latest.sha256[target] ?? missing("the stable manifest", target),
    };
  }
  const preview = source.preview;
  const asset = preview.assets[target] ?? missing("the preview manifest", target);
  return {
    label: `preview ${preview.build_id}`,
    protocol: preview.protocol,
    url: asset.url,
    sha256: asset.sha256,
  };
}
