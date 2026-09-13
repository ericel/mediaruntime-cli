# Assisted clipping (1.4.0)

Requires CLI and Node SDK 1.4.0 or newer. Earlier versions do not include these
controls. The gateway and worker must
also deploy `clip_candidates_v1` and `video_clip_v1`. The live capability catalog
controls which presets an account can run.

## Analyze → review → render

Analyze and download the resulting plan using the normal job flow. Choose a minimum
no longer than the source (the 15-second default does not fit a 12-second video):

```sh
mediaruntime run https://your-cdn.example/episode.mp4 \
  --preset clip_candidates_v1 --clip-min-duration 15 --clip-max-duration 60 \
  --clip-count 5 --clip-keyword deployment --download analysis.zip
```

`--download` implies `--wait`. Extract `clip_candidates.json` from the ZIP, review
its candidates and transcript, and choose a range. Scores express transcript and
pause heuristics, not predicted engagement. Analysis produces a JSON report, not
rendered clips. Empty candidates are a successful result when nothing matches;
`empty_reason` explains `no_speech`, `no_keyword_match`, `no_matching_ranges`, or
`source_too_short` when present. A nonempty transcript can still be reused. Current
preflight rejects a minimum longer than the source before analysis begins.

Render the reviewed range from the **same source**:

```sh
mediaruntime run https://your-cdn.example/episode.mp4 \
  --preset video_clip_v1 --clip-start 20 --clip-duration 30 \
  --clip-layout vertical_blur --clip-transcript clip_candidates.json --clip-captions \
  --download clip.zip
```

The example needs a source of at least 50 seconds. Replace its start and duration
with the candidate you reviewed; CLI does not automatically pick or submit a candidate.
The ZIP includes the MP4, poster, and SRT/VTT sidecars when a transcript intersects
the range. `--clip-captions` additionally burns that supplied text into the video.
Omit `--clip-captions` to keep sidecars only.

## Manual clips and existing captions

Manual clipping requires no transcription or Whisper model:

```sh
mediaruntime run ./source.mp4 --preset video_clip_v1 \
  --clip-start 1 --clip-duration 5 --download manual-clip.zip

mediaruntime run ./source.mp4 --preset video_clip_v1 \
  --clip-start 1 --clip-duration 5 --clip-transcript ./source.srt \
  --clip-captions --download captioned-clip.zip
```

`--clip-transcript` accepts a **local** `.srt`, `.vtt`, or `.json` file. JSON may
be a report with `transcript` or a bare segment array. Snake-case API fields
`start_time_sec` / `end_time_sec` and camel-case Node fields `startTimeSec` /
`endTimeSec` are accepted with `text`. SRT/VTT styling is flattened into plain text.
Cloud URLs and storage paths are not transcript file arguments: download the file
locally first. Main media sources continue to support the usual upload/source flow.

Times refer to the **full original source**, not the trimmed clip. Do not subtract
the clip start; the engine intersects and rebases captions. Burning requires text
that overlaps the selected range. Text need not describe the content for a rendering
test, but use accurate transcripts for meaningful speech suggestions.

Attachments must be UTF-8, at most 1 MiB, and contain 1–2000 ordered segments.
Each cue needs a finite start ≥ 0, end > start, and nonblank text of at most
2000 UTF-8 bytes. Total text is bounded to 256 KiB and timestamps to 604800 seconds.
Source duration/range validity is checked by gateway/engine preflight.

## Controls and processing

| Option | Bound/default |
| --- | --- |
| `--clip-start` | Required for render; 0–604800 seconds |
| `--clip-duration` | Required for render; 0.1–300 seconds, wholly within source |
| `--clip-layout` | `original` (default) or `vertical_blur` |
| `--clip-min-duration` | Analysis: 1–300 seconds; default 15 |
| `--clip-max-duration` | Analysis: 1–300 seconds; default 60; ≥ minimum |
| `--clip-count` | Analysis: integer 1–20; default 5 |
| `--clip-keyword` | Analysis: repeat up to 20 times, 1–100 UTF-8 bytes each |
| `--clip-transcript` | Local JSON/SRT/VTT attachment for either clipping preset |
| `--clip-captions` | Render only; opt-in burn, requires transcript |

Clipping controls require exactly one corresponding `--preset`; they cannot be
combined with a hosted recipe or ambiguously target multiple outputs.

Analysis is Premium. Without supplied text it uses the worker's **existing Whisper
base model**, which must be available in that runtime. Supplying `--clip-transcript`
for analysis bypasses Whisper. This feature introduces no additional ML model.
Standard renders cap original framing at a 1920-pixel long edge and 30 fps;
vertical blur-fill uses 720×1280 at up to 30 fps. Account settings may select a
higher effective tier. Premium analysis depends on the deployment's Sandbox
configuration; use a funded account when that Sandbox disables Premium processing.

## Local release verification

Build and pack the sibling Node SDK 1.4.0 first, then install its tarball only for
local verification, keeping the committed dependency as `^1.4.0`:

```sh
npm install --offline --no-save --package-lock=false /path/to/mediaruntime-node-1.4.0.tgz
npm run check
npm test
node dist/cli.js --version
```

The CLI checks that its SDK supports clipping before submission. Do not publish a
filesystem dependency. After publishing the SDK, regenerate the CLI lock with
`npm install --package-lock-only`, run a clean `npm ci` and package smoke test, then
publish the CLI. Registry publication and deployed-service verification are separate
release steps; passing local tests does not assert they have happened.
