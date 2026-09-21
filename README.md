# MediaRuntime CLI

Official command-line client for MediaRuntime. It submits media, waits for jobs, downloads
the canonical ZIP output bundle, inspects account jobs, and sends correctly signed
synthetic webhooks to a local receiver.

Version `1.5.0` adds `run --no-webhook` for local development against hosted MediaRuntime. Use `--wait` or `--download` to retrieve results without a callback. Normal account billing applies; omitting the switch preserves normal webhook delivery.

```bash
mediaruntime run ./product-video.mp4 --output video.web --no-webhook --download ./result.zip
```

This suppresses callbacks even when your account has a live endpoint. The account configuration is unchanged. Webhook retries cannot override the job's opt-out. A polling timeout does not cancel processing: keep the printed job ID and use `mediaruntime jobs get <job-id>` to check it instead of creating another billable job.

Version `1.4.0` adds [clipping commands](docs/clipping.md) for analysis,
manual ranges, vertical blur-fill, and JSON/SRT/VTT transcript attachments. It requires
Node SDK 1.4.0 or newer and a gateway/engine deployment supporting the clipping
presets. The live capability catalog determines which presets are available.

The documented `1.x` command names, flags, JSON envelopes, exit
codes, and credential precedence follow semantic versioning. Breaking changes require a
new major version; additive commands and fields may ship in minor releases.

## Install

```bash
npm install --global @mediaruntime/cli
mediaruntime --version
```

Node.js 22 or newer is required. For interactive use, authorize through the browser once:

```bash
mediaruntime login
mediaruntime auth status
```

The CLI stores its dedicated revocable key in the operating-system credential vault; it
never writes the key to a plaintext configuration file. Use `mediaruntime logout` to
revoke and remove it.

For CI, servers, containers, and deliberate account overrides, continue setting:

```bash
export MEDIARUNTIME_API_KEY="sk_..."
```

An explicit `MEDIARUNTIME_API_KEY` permanently remains supported and takes precedence
over the stored login. Do not pass credentials as command-line arguments. `--base-url` and
`MEDIARUNTIME_API_URL` are development/staging overrides, not normal client setup.

## Run a job

```bash
# Relative and absolute local paths are uploaded automatically.
mediaruntime run ./launch.mp4 --output video.web --wait

mediaruntime run "/Users/you/Videos/launch.mp4" \
  -o video.streaming \
  -o audio.transcription \
  --metadata '{"asset_id":"launch-01"}' \
  --idempotency-key 'asset:launch-01:v1' \
  --download ./launch-01.zip
```

`--download` implies `--wait`. The CLI streams the complete MediaRuntime ZIP bundle to a
temporary file, validates its advertised size and SHA-256 when available, and publishes
it atomically. Existing files are preserved unless `--force` is explicit. Signed download
URLs are never printed.

In an interactive terminal, `run` displays an elapsed-time spinner while it uploads a
local source, waits for the terminal job state, and downloads and verifies the bundle.
The indicator uses `stderr` and is automatically disabled for `--json`, redirected
output, and other non-interactive execution.

Supported frozen output aliases:

- `video.web`
- `video.streaming`
- `video.social`
- `audio.web`
- `audio.transcription`
- `image.web`

Discover the live public catalog without signing in, then select an explicit preset when
an alias is not specific enough:

```bash
mediaruntime capabilities
mediaruntime presets list
mediaruntime presets list --json

mediaruntime run ./launch.mp4 \
  --preset dash_ladder_v1 \
  --preset webm_vp9_1080p \
  --download ./adaptive-and-vp9.zip
```

`--preset` accepts only IDs in the gateway's current `publicPresets` catalog. The CLI
retrieves the catalog and supplies the preset's required output type automatically. Alias
and preset selections may be mixed and repeated in one command.

Animated WebP and APNG are explicit Premium presets. Their bounded controls apply when
exactly one animation preset is selected (`0` loops forever; APNG is lossless and does
not accept `--animation-quality`):

```bash
mediaruntime run ./clip.mp4 \
  --preset image_animated_webp_v1 \
  --animation-width 720 \
  --animation-fps 15 \
  --animation-duration 6 \
  --animation-loop 0 \
  --animation-quality 80 \
  --wait --download ./animated-webp.zip
```

Generate BlurHash, ThumbHash, and a byte-bounded WebP LQIP from an image or video frame
with the Standard `image_placeholders_v1` preset:

```bash
mediaruntime run ./product-photo.png \
  --preset image_placeholders_v1 \
  --placeholder-max-dimension 32 \
  --placeholder-time 0 \
  --lqip-quality 50 \
  --lqip-max-bytes 4096 \
  --wait --download ./placeholders.zip
```

The ZIP contains `placeholders.json` and `lqip.webp`. If the encoded image exceeds
`--lqip-max-bytes`, the job fails instead of returning an artifact over the requested
ceiling. The JSON includes source and placeholder dimensions, source format, the
requested timestamp, and an alpha-aware dominant colour. `--placeholder-time` defaults
to the first frame at `0`; it does not request automatic representative-frame selection.

Generate bounded composite review sheets from a video with one flat Standard processing
unit per produced sheet:

```bash
mediaruntime run ./interview.mp4 \
  --preset contact_sheet_v1 \
  --contact-columns 5 \
  --contact-rows 4 \
  --contact-tile-width 240 \
  --contact-tile-height 135 \
  --contact-interval 12 \
  --contact-max-sheets 3 \
  --contact-format jpg \
  --contact-quality 80 \
  --wait --download ./contact-sheets.zip
```

The ZIP contains numbered composite images and `contact_sheet.json`, which maps every
tile to its exact source timestamp. `--contact-duration 0` means the remaining video.
`--contact-quality` applies to JPG and WebP; PNG is lossless.

Guarantee that a JPG or WebP rendition stays within a hard byte ceiling:

```bash
mediaruntime run ./photo.png \
  --preset image_multi_v1 \
  --image-width 1280 --image-height 720 --image-mode cover \
  --image-format webp --image-quality 86 \
  --image-max-bytes 200000 --image-min-quality 35 \
  --wait --download ./bounded-image.zip
```

MediaRuntime performs a bounded quality search and verifies the final file. If the
constraint cannot be met, the job fails instead of returning an oversized image. The ZIP
includes `image_size_limits.json`; PNG and AVIF do not accept `--image-max-bytes` yet.

## Privacy redaction

Privacy redaction is an explicit Premium Preview for still-image inputs and image outputs.
The CLI rejects obvious video or animated-image sources locally, expands the selected
preset through the live capability catalog, and confirms the output is an image before
uploading local media:

```bash
mediaruntime run ./team-photo.jpg \
  --preset image_multi_v1 \
  --privacy-detector face \
  --privacy-detector license_plate \
  --privacy-detector text \
  --privacy-style blur \
  --privacy-failure-mode fail_closed \
  --wait --download ./redacted.zip
```

Detector flags are repeatable. Optional bounds include `--privacy-min-confidence`,
`--privacy-sample-interval`, `--privacy-max-frames`, and `--privacy-padding`; solid masks
also accept `--privacy-solid-color`, while pixelation accepts
`--privacy-pixel-block-size` and `--privacy-strength`. Per-sample observations are
available only with `--privacy-debug-observations`. The ZIP contains the redacted image and
`privacy_redaction.json` schema v3. Public metadata reports stable detector categories,
counts, verification outcomes, and ZIP-relative `report_bundle_path` and
`output_bundle_paths`; it excludes detector vendors, model identities, private model or
worker paths, bucket names, and raw OCR text. Automated detection can miss sensitive
regions, so `coverage_verified` remains false and review is required before regulated use.
In `fail_closed` mode detector failure, unresolved ambiguity, truncation,
or a verified residual prevents image delivery. Recognizable residuals under blur or
pixelation may be escalated to bounded opaque masks and verified again. Detector recall
remains non-exhaustive.
`--privacy-max-frames` applies independently to each 60-second segment. The defaults are a
0.2-second interval and 1,800 frames per segment.

## Hosted recipes

Hosted recipes are immutable account-scoped versions of a complete outputs, moderation,
and watermark policy. Discover the built-ins and your team's custom recipes, then run one
without copying configuration:

```bash
mediaruntime recipes list
mediaruntime recipes get team-video --version 3
mediaruntime run ./launch.mp4 \
  --recipe team-video@3 \
  --download ./launch.zip
```

Owners and admins can manage custom recipes from JSON files:

```bash
mediaruntime recipes create --file ./recipe.json
mediaruntime recipes version team-video --file ./recipe-v2.json --expected 1
mediaruntime recipes archive team-video
```

`recipe.json` contains `name`, optional `description`, and `template`; a version file may
contain either a complete object with `template` or the template itself. Versions are
immutable, and `--expected` prevents concurrent editors from silently overwriting one
another. `--recipe` cannot be combined with `--output` or `--preset`.

Use `--json` for one compact, URL-redacted machine-readable result. A caller-provided
`--idempotency-key` remains the durable deduplication mechanism across process restarts;
the SDK-generated invocation key only protects retries inside one live command.

## Check video compatibility

The CLI reads the live capability catalog, so it can run the versioned compatibility
preset without hard-coding its profile rules:

```bash
mediaruntime run ./launch.webm \
  --preset compatibility_report_v1 \
  --download ./launch-compatibility.zip
```

The ZIP contains `compatibility_report.json` with five conservative web, mobile,
social-upload, and editing profiles, rule-level evidence, and existing corrective preset
recommendations. It is actionable guidance, not exhaustive certification of every device.

## Scan QR codes and barcodes

Use the live `code_detect_v1` preset with an image, video, animated image, or an
audio file that contains embedded cover artwork:

```sh
mediaruntime run ./product-label.png \
  --preset code_detect_v1 \
  --wait --download ./detected-codes.zip
```

The ZIP contains `codes.json` plus evidence PNGs only for frames with unique
detections. Video is sampled at the opening frame and every 10 seconds, up to 12
frames and 16 unique codes per frame. Plain audio without cover artwork is rejected. Decoded values are untrusted:
render them as text and never automatically open a detected URL.

## Generate an audiogram

Compose an audio track, supplied artwork, a generated waveform, and optional supplied
captions with the Premium `audiogram_v1` preset. The main audio, artwork, and captions
may each be local files; the CLI uploads local assets through the authenticated account's
signed-upload flow before creating the job:

```bash
mediaruntime run ./episode.mp3 \
  --preset audiogram_v1 \
  --audiogram-artwork ./cover.png \
  --audiogram-captions ./episode.vtt \
  --audiogram-layout square \
  --audiogram-fit blurred_background \
  --audiogram-background '#101827' \
  --audiogram-waveform '#5B5CFF' \
  --audiogram-waveform-gain 2 \
  --audiogram-caption-position bottom \
  --audiogram-caption-scale 1 \
  --audiogram-normalize --audiogram-loudness-target -16 \
  --audiogram-duration 60 \
  --audiogram-fps 30 \
  --wait --download ./audiogram.zip
```

Artwork must be PNG, JPEG, or WebP up to 10 MB. Captions must be UTF-8 SRT or VTT up
to 2 MB; supplying captions burns them into the video. The ZIP contains
`audiogram.mp4`, a caption-free `poster.jpg`, `audiogram.json`, and
`audiogram.waveform.json`. Artwork fitting, waveform gain, caption placement, and
optional loudness normalization are bounded named controls. Account watermarking
and speech-generated subtitles cannot be combined with this preset in v1.

Captions use their own top or bottom strip inside the reserved band and cannot cover caller
artwork. Multi-line cues scale down adaptively. The caption-free poster is sampled after
waveform activity begins, and successful normalization reports measured loudness values.

## Hosted Sticker Runtime

Sticker collections are free application configuration over packs your workspace already
activated. Create a collection, then enable an existing paid Hosted Pack by its stable pack
ID or activation ID:

```bash
mediaruntime stickers collections create \
  --name "Support chat" \
  --description "Customer-facing reactions"

mediaruntime stickers collections list
mediaruntime stickers collections get stc_0123456789abcdef0123456789abcdef
mediaruntime stickers collections update stc_0123456789abcdef0123456789abcdef \
  --name "Support and community"

mediaruntime stickers collections packs enable stc_0123456789abcdef0123456789abcdef \
  --pack white-sage-just-me
mediaruntime stickers collections packs list stc_0123456789abcdef0123456789abcdef
mediaruntime stickers collections packs disable stc_0123456789abcdef0123456789abcdef \
  --pack white-sage-just-me
```

Disabling a pack prevents new discovery but preserves exact historical rendering under the
binding's `historicalAccess` policy. `collections archive` is also recoverable; restore with
`collections update <id> --status active`. These commands do not buy, activate, revoke, or
charge for a pack. Use the authenticated MediaRuntime account surface for paid activation.

Search and resolve assets inside one explicitly selected collection:

```bash
mediaruntime stickers packs list --collection stc_0123456789abcdef0123456789abcdef
mediaruntime stickers search "wave" \
  --collection stc_0123456789abcdef0123456789abcdef \
  --category greeting --animated --limit 10
mediaruntime stickers typeahead "wa" \
  --collection stc_0123456789abcdef0123456789abcdef --locale en
mediaruntime stickers get white-sage-just-me-wave \
  --collection stc_0123456789abcdef0123456789abcdef
mediaruntime stickers resolve white-sage-just-me-wave \
  --variant small_160 \
  --collection stc_0123456789abcdef0123456789abcdef
```

All sticker commands use `MEDIARUNTIME_API_KEY` or the secure browser login by default.
Untrusted application testing may instead set a short-lived token for only the five runtime
read commands above:

```bash
mediaruntime stickers token create \
  --collection stc_0123456789abcdef0123456789abcdef \
  --expires-in 900 \
  --scope packs:read \
  --scope stickers:search \
  --scope stickers:read \
  --scope assets:resolve

export MEDIARUNTIME_STICKER_CLIENT_TOKEN="mrt_v1_..."
mediaruntime stickers search "wave" \
  --collection stc_0123456789abcdef0123456789abcdef
```

The scoped token never authorizes collection management, pack binding, workspace usage, or
token minting; those always require the trusted API key. The CLI accepts the scoped secret
only through `MEDIARUNTIME_STICKER_CLIENT_TOKEN`, not a command-line flag. The collection
argument must still match the token claim. Inspect pooled monthly usage with
`mediaruntime stickers usage`. See [the Sticker Runtime command contract](docs/STICKERS.md)
for complete flags, JSON behavior, and security boundaries.

## Inspect jobs

```bash
mediaruntime jobs list --limit 20
mediaruntime jobs list --status COMPLETED --json
mediaruntime jobs get job_123
mediaruntime jobs get job_123 --download ./job_123.zip
```

Listing reads one page and prints an opaque next cursor when another page exists. Pass it
back with `--cursor`; the CLI does not decode or automatically walk pagination.

## Test a local webhook receiver

Use the same webhook secret configured in the local application:

```bash
export MEDIARUNTIME_WEBHOOK_SECRET="whsec_..."

mediaruntime trigger job.completed \
  --to http://127.0.0.1:3000/webhooks/mediaruntime
```

`trigger` supports `job.completed`, `job.failed`, and `job.rejected`. It signs the exact
JSON bytes with the production `X-Transcoder-*` HMAC protocol and sends them directly to
an explicit loopback URL. It does not call the MediaRuntime API, create a tunnel, register
a webhook, or follow redirects. `--secret-file` avoids environment configuration;
`--generate-secret` is an explicit local-harness mode and prints only the newly generated
secret.

See [the trigger security notes](docs/TRIGGER.md) for the complete local-delivery contract.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Command succeeded |
| `1` | Unexpected CLI error |
| `2` | Invalid arguments or missing configuration |
| `3` | Authentication, billing, or permission failure |
| `4` | Non-retryable API result or exhausted throttling |
| `5` | Connection, timeout, or exhausted server failure |
| `6` | Job ended as `FAILED`, `REJECTED`, or `PARTIAL` |
| `7` | Job wait timed out |
| `8` | Local trigger endpoint rejected the event |
| `9` | Bundle availability, integrity, redemption, or filesystem failure |
| `130` | Interrupted with `SIGINT` |

The full implementation contract is in [docs/CLI_SDD.md](docs/CLI_SDD.md).

## Scope

The CLI does not implement `listen` or a webhook relay. Production completion continues
to use the account destination under Account → Webhooks. The ZIP remains the canonical
completed-job result. See [browser authentication](docs/AUTH.md) for the complete login,
credential precedence, and security contract.
