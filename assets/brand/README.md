# Collie brand kit

Collie's black-and-white companion identity uses a friendly graphic style. The mascot's floppy ears, broad muzzle, and continuous white stripe from forehead to nose define the mark. This kit contains the exact artwork shown in the brand showcase.

## Choose the right asset

| Use                                    | Files                                               | Sizes                                  |
| -------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| Standalone mark                        | `logos/collie-mark-*.png`                           | 32, 48, 64, 128, 256, 512, and 1024 px |
| Horizontal signature on light surfaces | `logos/collie-horizontal-black-*.png`               | 512, 1024, and 2048 px wide            |
| Horizontal signature on dark surfaces  | `logos/collie-horizontal-light-*.png`               | 512, 1024, and 2048 px wide            |
| Stacked signature                      | [Stacked logo](logos/collie-stacked-black-1024.png) | 1024 × 1160 px                         |
| Browser favicon                        | [favicon.ico](icons/favicon.ico)                    | Embedded 16, 32, and 48 px images      |
| Browser PNG icons                      | `icons/favicon-*.png`                               | 16, 32, and 48 px                      |
| Apple touch icon                       | [Touch icon](icons/apple-touch-icon.png)            | 180 × 180 px                           |
| App icons                              | `icons/android-chrome-*.png`                        | 192 and 512 px                         |
| Maskable app icon                      | [Maskable icon](icons/maskable-icon-512.png)        | 512 px, with a safe central mark       |
| GitLab project avatar                  | [Project avatar](gitlab/collie-project-avatar.png)  | 192 × 192 px                           |

The [master](source/collie-master.png) is a 1254 × 1254 transparent PNG. The signatures compose this same mark with Nunito Sans lettering. All artwork in this delivery is raster; a vector master is not included. Keep the exported files at or below their native pixel dimensions.

## Logo use

- Leave clear space equal to at least 25% of the mark's height on every side, outside the supplied canvas.
- Preserve the aspect ratio, facial markings, and colors.
- Use the black signature on white, chalk, or mist.
- Use the light signature, including its light icon tile, on black or deep black.
- Use the dedicated favicon and app icon files in small spaces. Reserve full signatures for sizes where the name remains readable.
- Keep the Collie wordmark lowercase. Refer to the product as **Collie** in prose.

## Color

| Name        | Hex       | Role                           |
| ----------- | --------- | ------------------------------ |
| Black      | `#171717` | Primary identity and actions   |
| Deep black | `#101010` | Dark surfaces                  |
| Silver      | `#dedede` | A restrained accent            |
| Mist        | `#ededed` | Supporting surfaces            |
| Chalk       | `#fafafa` | Main background and light text |
| Ink         | `#262626` | Body text                      |

Use chalk text on black and deep black. Use ink text on silver, mist, and chalk. Import the values from [CSS tokens](tokens/brand.css) or [JSON tokens](tokens/brand.json).

## Typography and voice

- **Nunito Sans 900:** the wordmark and identity lettering. The supplied signatures include the finished lettering.
- **DM Sans 400–700:** body copy, labels, and interface headings.
- Use direct, calm language: what changed, what is happening, and what needs a decision. Preserve the human's role in setting direction.
- Brand line: **Good work. Good company.**

The original font files and their SIL Open Font License notices are included in `fonts/`. Retain [Nunito Sans's license](fonts/nunito-sans-license.txt) and [DM Sans's license](fonts/dm-sans-license.txt) when distributing the fonts. Sources: [Nunito Sans](https://github.com/google/fonts/tree/main/ofl/nunitosans) and [DM Sans](https://github.com/google/fonts/tree/main/ofl/dmsans).

## Use on a website

Copy this directory to your public `brand/` directory. Adapt the paths in [the HTML snippet](web/head.html) if you use a different location. The [web app manifest](web/site.webmanifest) references the included icons by relative paths.

The showcase includes the rerendered [launch film](../video/collie-launch.mp4) and a comparison with the previous green identity.

The showcase uses the same favicon and touch icon files. The 16 px preview is rendered at its actual pixel size.

## Repository and GitLab integration

The proposed kit belongs in Collie's `assets/brand/` directory. For future asset updates:

1. Add the extracted `assets/brand/` directory to `mk/collie` on a branch based on the current `master`.
2. Add the horizontal black signature to the repository README, using a relative link to `assets/brand/logos/collie-horizontal-black-1024.png` and a display width of about 360 px.
3. Open the merge request with `--assignee mk`.
4. Upload `gitlab/collie-project-avatar.png` as the project avatar for GitLab project `2225` (`mk/collie`), using the `avatar` multipart field on `PUT /api/v4/projects/2225`.
5. Verify the repository asset links and the project's returned `avatar_url`.

The avatar is prepared at GitLab's recommended 192 × 192 px and checked against its 200 KB limit. See the [GitLab project avatar documentation](https://docs.gitlab.com/api/projects/#upload-a-project-avatar).

[handoff.json](handoff.json) records the target repository and upload details. [asset-manifest.json](asset-manifest.json) records file sizes, dimensions, and SHA-256 hashes. [Generation details](source/generation.json) document the personalized master.
