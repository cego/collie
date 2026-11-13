# Native dependency review

Reviewed 2026-11-12 for PR #398, against `desktop/Cargo.lock` and Rune
`781e2b6d87cd5f32d6f4365956fad4baaf24ee50`. This records evidence and limits;
it does not suppress advisories or claim the dependencies have been upgraded.

Recheck these constraints by 2026-11-26, or sooner when the owning libraries publish
compatible fixes. Review reachability again before adding image color-profile processing
or accepting serialized syntax grammars from outside the application.

The PR's Aikido comment reports moxcms 0.8.1 (fixed 0.9.0), weezl 0.1.12
(fixed 0.2.0), and bincode 1.3.3 (no fixed version). All three are compiled,
rather than merely present in the lockfile. Cargo-audit 0.23.0, using the
2026-11-12 RustSec database, reports zero vulnerability advisories and five
unmaintained-package warnings. That database does not cover every Aikido finding.

## moxcms 0.8.1

[AIKIDO-2026-175889](https://intel.aikido.dev/cve/AIKIDO-2026-175889) is a
pre-CVE out-of-bounds-read advisory, fixed in 0.9.0. It requires parsing or
transforming untrusted ICC LUT/CLUT profiles with malformed dimensions or channel
counts. See the [official 0.9.0 fixes](https://github.com/awxkee/moxcms/releases/tag/0.9.0).

The dependency path is image 0.25.10, used by Collie's chat, Rune, and arboard.
Image enables moxcms's default LUT features. Current application decoding uses
`image::load_from_memory` and `DynamicImage::from_decoder`; Rune also reads EXIF
orientation. These paths read pixels without parsing ICC profiles into moxcms;
the image implementation assumes sRGB. No application or pinned Rune call to
moxcms's ICC profile parser was found. This specific advisory therefore appears
unreachable through the reviewed APIs; that conclusion must be revisited if ICC
profile handling is introduced.

Image 0.25.10 requires moxcms `^0.8.0`, excluding the fixed 0.9 series. No newer
image release was available at review. An [official unpublished image change](https://github.com/image-rs/image/commit/89c008d5c3710f4aae3d2a669366e41c9028ded4)
omits LUT features but retains the 0.8 dependency. Updating Rune alone does not
resolve this constraint.

## weezl 0.1.12

The PR comment supplies no advisory identifier. RustSec, OSV, and GitHub's
reviewed advisory database returned no matching published advisory at review;
[Aikido's public package page](https://intel.aikido.dev/packages/cargo/weezl)
also reported no vulnerabilities for 0.1.12. The PR finding remains unresolved
at the advisory-identification level; no identifier is inferred here.

The compiled Linux path is gif 0.14.2 through image's enabled GIF feature. On
macOS, arboard also enables image's TIFF decoder, using tiff 0.11.3. The
[official weezl changelog](https://github.com/image-rs/weezl/blob/master/Changes.md)
and [regression PR #64](https://github.com/image-rs/weezl/pull/64) document a
malformed-stream panic involving initial code size 12, fixed in 0.2.0. GIF
0.14.2 rejects initial code sizes above 11; TIFF 0.11.3 constructs its LZW decoder
with size 8. That documented trigger is unreachable through these callers.
This does not establish that the unidentified Aikido advisory has the same trigger.

The latest released gif 0.14.2 and tiff 0.11.3 require weezl 0.1, excluding 0.2.
Official unpublished upgrades exist in [GIF](https://github.com/image-rs/image-gif/commit/e60e4dd7708cc50f9371185cefa04273f410f116)
and [TIFF](https://github.com/image-rs/image-tiff/commit/0fdf1e05021983061f3a1029adfd1ace147c7dc6).
A normal update within the released dependency constraints cannot select them.

## bincode 1.3.3

[RUSTSEC-2025-0141](https://rustsec.org/advisories/RUSTSEC-2025-0141) is an
informational unmaintained-package advisory, with no patched version. It does
not describe a newly discovered exploit or assign a CVE. The maintainers consider
1.3.3 complete and have ceased development.

The dependency comes through syntect 5.3.0 and two-face 0.5.2. Collie's highlighter
loads two-face's embedded syntax dumps, rather than user-supplied bincode data;
untrusted code text is subsequently highlighted. Syntect's parsing feature
requires its dump support, so disabling default features alone does not remove
bincode while retaining the current parser. Syntect 5.3.0 was the latest release
at review. Removing this maintenance dependency requires an upstream migration
or changing the syntax-highlighting implementation, not a compatible lock update.

## JavaScript dependencies

The same review refreshed compatible patched versions of Zod, body-parser,
brace-expansion, fast-uri, ip-address, qs and seroval. Both committed Bun lockfiles
were audited again: the desktop audit reports no advisories, and the root audit
reports no high or critical advisories. The remaining root findings concern
@babel/core (low) and glob/minimatch (moderate), through @opentui/solid's build
tooling. The reported affected operations do not handle remote application input.
The owning dependencies still constrain the older releases; forcing incompatible
major versions through overrides would bypass those interfaces. Recheck those
constraints on the same date above or when @opentui/solid publishes an update.
