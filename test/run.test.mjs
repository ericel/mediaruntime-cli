import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCli } from "../dist/cli.js";

function details(status = "COMPLETED") {
  return {
    id: "job_run",
    status,
    tier: { requested: "standard", required: "standard", effective: "standard", billed: "standard", reasons: [] },
    usage: { unitsTotal: 4 },
    billing: {
      status: "PAID",
      currency: "USD",
      unitPriceCents: 1,
      finalUnits: 4,
      finalAmountCents: 4,
      estimatedUnits: 4,
      estimatedAmountCents: 4,
    },
    bundle: {
      available: status === "COMPLETED",
      downloadUrl: status === "COMPLETED" ? "https://signed.example.test/bundle?token=secret" : null,
      expiresAt: "2026-08-17T00:00:00Z",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      retentionDays: 7,
    },
    media: null,
    metadata: { Asset_Key: "preserved" },
    error: status === "FAILED" ? "engine failed" : null,
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:01Z",
    startedAt: "2026-08-16T00:00:00Z",
    completedAt: status === "COMPLETED" ? "2026-08-16T00:00:01Z" : null,
  };
}

function submitted(result = details()) {
  return {
    id: "job_run",
    status: "QUEUED",
    tier: "standard",
    requiredTier: null,
    outputs: [],
    message: "accepted",
    wait: async (options) => {
      submitted.waitOptions = options;
      return result;
    },
  };
}

test("run passes local source and aliases through, waits, and downloads only the bundle", async () => {
  let createParams;
  let clientOptions;
  let download;
  let output = "";
  const job = submitted();
  const code = await executeCli([
    "--base-url", "http://127.0.0.1:8001",
    "run", "./fixtures/video.mp4",
    "--output", "video.web",
    "--output", "audio.web",
    "--metadata", "{\"Asset_Key\":\"preserved\"}",
    "--idempotency-key", "asset:video:v1",
    "--timeout-ms", "1234",
    "--download", "./job_run.zip",
    "--force",
  ], {
    createClient: (options) => {
      clientOptions = options;
      return {
        jobs: {
          create: async (params) => {
            createParams = params;
            return job;
          },
          list: async () => { throw new Error("not used"); },
          get: async () => { throw new Error("not used"); },
        },
      };
    },
    downloadBundle: async (url, destination, options) => {
      download = { url, destination, options };
    },
    writeStdout: (text) => { output += text; },
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.deepEqual(clientOptions, { baseUrl: "http://127.0.0.1:8001" });
  assert.deepEqual(createParams, {
    source: "./fixtures/video.mp4",
    outputs: ["video.web", "audio.web"],
    metadata: { Asset_Key: "preserved" },
    idempotencyKey: "asset:video:v1",
  });
  assert.deepEqual(submitted.waitOptions, { timeoutMs: 1234 });
  assert.deepEqual(download, {
    url: "https://signed.example.test/bundle?token=secret",
    destination: "./job_run.zip",
    options: { force: true, expectedSizeBytes: 1024, expectedSha256: "a".repeat(64) },
  });
  assert.match(output, /Downloaded bundle to \.\/job_run\.zip/);
  assert.doesNotMatch(output, /signed\.example|token=secret/);
});

test("run accepts one hosted recipe without fetching capabilities", async () => {
  let createParams;
  let capabilitiesRead = false;
  const writes = { stdout: "", stderr: "" };
  const job = submitted();
  job.recipe = {
    name: "team-video",
    version: 3,
    reference: "team-video@3",
    builtIn: false,
    sha256: "a".repeat(64),
  };
  const code = await executeCli([
    "run", "./launch.mp4", "--recipe", "team-video@3",
  ], {
    createClient: () => ({
      jobs: {
        create: async (params) => { createParams = params; return job; },
      },
      capabilities: {
        retrieve: async () => { capabilitiesRead = true; throw new Error("not used"); },
      },
    }),
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  });
  assert.equal(code, 0);
  assert.deepEqual(createParams, { source: "./launch.mp4", recipe: "team-video@3" });
  assert.equal(capabilitiesRead, false);
  assert.equal(writes.stderr, "");
  assert.match(writes.stdout, /job_run/);
});

test("run rejects recipe and inline outputs together", async () => {
  const writes = { stdout: "", stderr: "" };
  const code = await executeCli([
    "run", "./launch.mp4", "--recipe", "web-video", "--output", "video.web",
  ], {
    createClient: () => ({ jobs: {}, capabilities: {} }),
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  });
  assert.equal(code, 2);
  assert.match(writes.stderr, /cannot be combined/);
});

test("interactive run shows upload, wait, and download activity without polluting stdout", async () => {
  let stdout = "";
  let stderr = "";
  const code = await executeCli([
    "run", "/Users/you/Videos/launch.mp4",
    "--output", "video.streaming",
    "--download", "./launch.zip",
  ], {
    createClient: () => ({
      jobs: {
        create: async () => submitted(),
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    downloadBundle: async () => {},
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; },
    isStderrTTY: true,
  });

  assert.equal(code, 0);
  assert.match(stderr, /Uploading local media and creating job/);
  assert.match(stderr, /Waiting for job job_run to complete/);
  assert.match(stderr, /Downloading and verifying ZIP bundle/);
  assert.match(stderr, /\u001b\[2K/);
  assert.doesNotMatch(stdout, /⣋|⣙|Uploading|Waiting|Downloading and verifying/);
  assert.match(stdout, /Downloaded bundle to \.\/launch\.zip/);
});

test("run activity is disabled for JSON and non-interactive output", async () => {
  for (const [json, isStderrTTY] of [[true, true], [false, false]]) {
    let stderr = "";
    const args = ["run", "./launch.mp4", "--output", "video.web", "--wait"];
    if (json) args.push("--json");
    assert.equal(await executeCli(args, {
      createClient: () => ({
        jobs: {
          create: async () => submitted(),
          list: async () => { throw new Error("not used"); },
          get: async () => { throw new Error("not used"); },
        },
      }),
      writeStdout: () => {},
      writeStderr: (text) => { stderr += text; },
      isStderrTTY,
    }), 0);
    assert.equal(stderr, "");
  }
});

test("run emits URL-redacted JSON and returns non-success for terminal failure", async () => {
  let output = "";
  let downloaded = false;
  const code = await executeCli([
    "run", "https://cdn.example.test/video.mp4",
    "--output", "video.web",
    "--wait",
    "--json",
  ], {
    createClient: () => ({
      jobs: {
        create: async () => submitted(details("FAILED")),
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    downloadBundle: async () => { downloaded = true; },
    writeStdout: (text) => { output += text; },
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 6);
  assert.equal(downloaded, false);
  const projected = JSON.parse(output);
  assert.equal(projected.status, "FAILED");
  assert.equal(projected.bundle.available, false);
  assert.equal("downloadUrl" in projected.bundle, false);
  assert.doesNotMatch(output, /signed\.example|token=secret/);
});

test("run accepts exactly the six frozen aliases and rejects unknown aliases locally", async () => {
  const aliases = [
    "video.web",
    "video.streaming",
    "video.social",
    "audio.web",
    "audio.transcription",
    "image.web",
  ];
  const forwarded = [];
  const makeDependencies = (error) => ({
    createClient: () => ({
      jobs: {
        create: async (params) => {
          forwarded.push(params.outputs[0]);
          return submitted();
        },
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { error.value += text; },
  });
  for (const alias of aliases) {
    const error = { value: "" };
    assert.equal(
      await executeCli(["run", "./video.mp4", "--output", alias], makeDependencies(error)),
      0,
    );
    assert.equal(error.value, "");
  }
  const error = { value: "" };
  assert.equal(
    await executeCli(["run", "./video.mp4", "--output", "video.future"], makeDependencies(error)),
    2,
  );
  assert.match(error.value, /Unsupported output alias/);
  assert.deepEqual(forwarded, aliases);
});

test("run resolves public presets to explicit output objects and preserves selection order", async () => {
  let createParams;
  let capabilityReads = 0;
  const code = await executeCli([
    "run", "./video.mp4",
    "--output", "video.web",
    "--preset", "dash_ladder_v1",
    "--preset", "webm_vp9_1080p",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => {
          capabilityReads += 1;
          return {
            publicPresets: ["dash_ladder_v1", "webm_vp9_1080p"],
            presets: {
              dash_ladder_v1: { outputType: "dash" },
              webm_vp9_1080p: { outputType: "webm" },
            },
          };
        },
      },
      jobs: {
        create: async (params) => {
          createParams = params;
          return submitted();
        },
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.equal(capabilityReads, 1);
  assert.deepEqual(createParams.outputs, [
    "video.web",
    { type: "dash", preset: "dash_ladder_v1" },
    { type: "webm", preset: "webm_vp9_1080p" },
  ]);
});

test("run resolves the live compatibility report preset without hard-coded rules", async () => {
  let createParams;
  const code = await executeCli([
    "run", "./video.webm", "--preset", "compatibility_report_v1",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["compatibility_report_v1"],
          presets: { compatibility_report_v1: { outputType: "image" } },
        }),
      },
      jobs: {
        create: async (params) => {
          createParams = params;
          return submitted();
        },
      },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.deepEqual(createParams.outputs, [
    { type: "image", preset: "compatibility_report_v1" },
  ]);
});

test("run resolves live QR/barcode detection for images, video, or audio artwork", async () => {
  let createParams;
  const code = await executeCli([
    "run", "./album-with-cover.mp3", "--preset", "code_detect_v1",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["code_detect_v1"],
          presets: { code_detect_v1: { outputType: "frames" } },
        }),
      },
      jobs: {
        create: async (params) => {
          createParams = params;
          return submitted();
        },
      },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.deepEqual(createParams.outputs, [
    { type: "frames", preset: "code_detect_v1" },
  ]);
});

test("run attaches bounded animation controls to one animated image preset", async () => {
  let createParams;
  const code = await executeCli([
    "run", "./video.mp4",
    "--preset", "image_animated_webp_v1",
    "--animation-width", "720",
    "--animation-fps", "15",
    "--animation-start", "1.5",
    "--animation-duration", "6",
    "--animation-loop", "0",
    "--animation-quality", "80",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["image_animated_webp_v1"],
          presets: { image_animated_webp_v1: { outputType: "image" } },
        }),
      },
      jobs: {
        create: async (params) => { createParams = params; return submitted(); },
      },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.deepEqual(createParams.outputs, [{
    type: "image",
    preset: "image_animated_webp_v1",
    animation: {
      width: 720,
      fps: 15,
      startTime: 1.5,
      duration: 6,
      loop: 0,
      quality: 80,
    },
  }]);
});

test("run rejects animation controls for ambiguous or incompatible selections", async () => {
  let error = "";
  const code = await executeCli([
    "run", "./video.mp4", "--preset", "image_animated_apng_v1", "--animation-quality", "80",
  ], {
    createClient: () => ({
      jobs: { create: async () => { throw new Error("must not create job"); } },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { error += text; },
  });

  assert.equal(code, 2);
  assert.match(error, /APNG is lossless/);
});

test("run attaches bounded placeholder controls to the placeholder preset", async () => {
  let createParams;
  const code = await executeCli([
    "run", "./poster.png",
    "--preset", "image_placeholders_v1",
    "--placeholder-max-dimension", "48",
    "--placeholder-time", "1.25",
    "--lqip-quality", "42",
    "--lqip-max-bytes", "2048",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["image_placeholders_v1"],
          presets: { image_placeholders_v1: { outputType: "image" } },
        }),
      },
      jobs: {
        create: async (params) => { createParams = params; return submitted(); },
      },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.deepEqual(createParams.outputs, [{
    type: "image",
    preset: "image_placeholders_v1",
    placeholders: {
      maxDimension: 48,
      sourceTimeSec: 1.25,
      lqipQuality: 42,
      lqipMaxBytes: 2048,
    },
  }]);
});

test("run rejects placeholder controls outside the gateway contract or on another selection", async () => {
  for (const args of [
    ["run", "./poster.png", "--preset", "image_placeholders_v1", "--lqip-max-bytes", "255"],
    ["run", "./poster.png", "--preset", "image_multi_v1", "--lqip-quality", "50"],
  ]) {
    let error = "";
    const code = await executeCli(args, {
      createClient: () => ({ jobs: { create: async () => { throw new Error("must not create job"); } } }),
      writeStdout: () => {},
      writeStderr: (text) => { error += text; },
    });
    assert.equal(code, 2);
    assert.match(error, /lqip-max-bytes|placeholder options/);
  }
});

test("run attaches bounded contact-sheet controls to contact_sheet_v1", async () => {
  let createParams;
  const code = await executeCli([
    "run", "./video.mp4",
    "--preset", "contact_sheet_v1",
    "--contact-columns", "5",
    "--contact-rows", "4",
    "--contact-tile-width", "240",
    "--contact-tile-height", "135",
    "--contact-interval", "12",
    "--contact-start", "3",
    "--contact-duration", "120",
    "--contact-max-sheets", "3",
    "--contact-format", "webp",
    "--contact-quality", "76",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["contact_sheet_v1"],
          presets: { contact_sheet_v1: { outputType: "frames" } },
        }),
      },
      jobs: { create: async (params) => { createParams = params; return submitted(); } },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.deepEqual(createParams.outputs, [{
    type: "frames",
    preset: "contact_sheet_v1",
    contactSheet: {
      columns: 5,
      rows: 4,
      tileWidth: 240,
      tileHeight: 135,
      intervalSec: 12,
      startTimeSec: 3,
      durationSec: 120,
      maxSheets: 3,
      format: "webp",
      quality: 76,
    },
  }]);
});

test("run rejects invalid or misplaced contact-sheet controls locally", async () => {
  for (const args of [
    ["run", "./video.mp4", "--preset", "contact_sheet_v1", "--contact-columns", "11"],
    ["run", "./video.mp4", "--preset", "contact_sheet_v1", "--contact-format", "avif"],
    ["run", "./video.mp4", "--preset", "contact_sheet_v1", "--contact-format", "png", "--contact-quality", "70"],
    ["run", "./video.mp4", "--preset", "contact_sheet_v1", "--contact-columns", "10", "--contact-tile-width", "640"],
    ["run", "./video.mp4", "--preset", "mp4_720p_h264_aac", "--contact-rows", "4"],
  ]) {
    let error = "";
    const code = await executeCli(args, {
      createClient: () => ({ jobs: { create: async () => { throw new Error("must not create job"); } } }),
      writeStdout: () => {},
      writeStderr: (text) => { error += text; },
    });
    assert.equal(code, 2);
    assert.match(error, /contact-columns|contact-format|contact-quality|contact-sheet (?:options|width)/);
  }
});

test("run attaches a hard JPG/WebP byte ceiling to image_multi_v1", async () => {
  let createParams;
  const code = await executeCli([
    "run", "./photo.png",
    "--preset", "image_multi_v1",
    "--image-width", "1280",
    "--image-height", "720",
    "--image-mode", "cover",
    "--image-format", "webp",
    "--image-quality", "86",
    "--image-max-bytes", "200000",
    "--image-min-quality", "35",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["image_multi_v1"],
          presets: { image_multi_v1: { outputType: "image" } },
        }),
      },
      jobs: { create: async (params) => { createParams = params; return submitted(); } },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.deepEqual(createParams.outputs, [{
    type: "image",
    preset: "image_multi_v1",
    images: [{
      width: 1280,
      height: 720,
      mode: "cover",
      format: "webp",
      quality: 86,
      maxBytes: 200000,
      minQuality: 35,
    }],
  }]);
});

test("run uploads local Audiogram assets and submits the exact bounded composition", async () => {
  let createParams;
  const resolved = [];
  const code = await executeCli([
    "run", "./episode.mp3",
    "--preset", "audiogram_v1",
    "--audiogram-artwork", "./cover.png",
    "--audiogram-captions", "./episode.vtt",
    "--audiogram-layout", "portrait",
    "--audiogram-fit", "blurred_background",
    "--audiogram-background", "#102030",
    "--audiogram-waveform", "#abcdef",
    "--audiogram-waveform-gain", "2.5",
    "--audiogram-caption-position", "bottom",
    "--audiogram-caption-scale", "1.1",
    "--audiogram-normalize",
    "--audiogram-loudness-target", "-18",
    "--audiogram-start", "2.5",
    "--audiogram-duration", "45",
    "--audiogram-fps", "24",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["audiogram_v1"],
          presets: { audiogram_v1: { outputType: "social" } },
        }),
      },
      uploads: {
        resolveSource: async (source) => {
          resolved.push(source);
          return `gs://account-input/${source.endsWith(".png") ? "cover.png" : "episode.vtt"}`;
        },
      },
      jobs: { create: async (params) => { createParams = params; return submitted(); } },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.deepEqual(resolved, ["./cover.png", "./episode.vtt"]);
  assert.deepEqual(createParams, {
    source: "./episode.mp3",
    outputs: [{
      type: "social",
      preset: "audiogram_v1",
      audiogram: {
        artworkSource: "gs://account-input/cover.png",
        captionsSource: "gs://account-input/episode.vtt",
        burnCaptions: true,
        layout: "portrait",
        artworkFit: "blurred_background",
        backgroundColor: "#102030",
        waveformColor: "#abcdef",
        waveformGain: 2.5,
        captionPosition: "bottom",
        captionFontScale: 1.1,
        normalizeAudio: true,
        loudnessTargetLufs: -18,
        startTimeSec: 2.5,
        durationSec: 45,
        fps: 24,
      },
    }],
  });
});

test("run validates Audiogram requirements and bounds before contacting the gateway", async () => {
  for (const args of [
    ["run", "./episode.mp3", "--preset", "audiogram_v1"],
    ["run", "./episode.mp3", "--preset", "audiogram_v1", "--audiogram-artwork", "./cover.png", "--audiogram-duration", "301"],
    ["run", "./episode.mp3", "--preset", "audiogram_v1", "--audiogram-artwork", "./cover.png", "--audiogram-fps", "14"],
    ["run", "./episode.mp3", "--preset", "audiogram_v1", "--audiogram-artwork", "./cover.png", "--audiogram-background", "navy"],
    ["run", "./episode.mp3", "--preset", "audiogram_v1", "--audiogram-artwork", "./cover.png", "--audiogram-fit", "stretch"],
    ["run", "./episode.mp3", "--preset", "audiogram_v1", "--audiogram-artwork", "./cover.png", "--audiogram-waveform-gain", "5"],
    ["run", "./episode.mp3", "--preset", "audiogram_v1", "--audiogram-artwork", "./cover.png", "--audiogram-caption-position", "middle"],
    ["run", "./episode.mp3", "--preset", "audiogram_v1", "--audiogram-artwork", "./cover.png", "--audiogram-loudness-target", "-30"],
    ["run", "./episode.mp3", "--preset", "audio_aac_128k", "--audiogram-artwork", "./cover.png"],
  ]) {
    let error = "";
    const code = await executeCli(args, {
      createClient: () => ({ jobs: { create: async () => { throw new Error("must not create job"); } } }),
      writeStdout: () => {},
      writeStderr: (text) => { error += text; },
    });
    assert.equal(code, 2);
    assert.match(error, /audiogram|Audiogram/);
  }
});

test("run rejects invalid or misplaced image byte constraints locally", async () => {
  for (const args of [
    ["run", "./photo.png", "--preset", "image_multi_v1", "--image-max-bytes", "255"],
    ["run", "./photo.png", "--preset", "image_multi_v1", "--image-min-quality", "35"],
    ["run", "./photo.png", "--preset", "image_multi_v1", "--image-format", "png", "--image-max-bytes", "4096"],
    ["run", "./photo.png", "--preset", "image_multi_v1", "--image-quality", "40", "--image-max-bytes", "4096", "--image-min-quality", "41"],
    ["run", "./photo.png", "--preset", "media_report_v1", "--image-max-bytes", "4096"],
  ]) {
    let error = "";
    const code = await executeCli(args, {
      createClient: () => ({ jobs: { create: async () => { throw new Error("must not create job"); } } }),
      writeStdout: () => {},
      writeStderr: (text) => { error += text; },
    });
    assert.equal(code, 2);
    assert.match(error, /image-max-bytes|image-min-quality|image rendition options/);
  }
});

test("run rejects presets outside the gateway public catalog", async () => {
  let requested = false;
  let error = "";
  const code = await executeCli([
    "run", "./video.mp4", "--preset", "internal_experimental_v1",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["dash_ladder_v1"],
          presets: {
            dash_ladder_v1: { outputType: "dash" },
            internal_experimental_v1: { outputType: "mp4" },
          },
        }),
      },
      jobs: {
        create: async () => { requested = true; throw new Error("must not run"); },
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { error += text; },
  });
  assert.equal(code, 2);
  assert.equal(requested, false);
  assert.match(error, /Unknown or non-public preset/);
});

test("run rejects timeout without wait or download", async () => {
  let requested = false;
  let error = "";
  const code = await executeCli([
    "run", "./video.mp4", "--output", "video.web", "--timeout-ms", "1000",
  ], {
    createClient: () => ({
      jobs: {
        create: async () => { requested = true; throw new Error("must not run"); },
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    writeStderr: (text) => { error += text; },
  });
  assert.equal(code, 2);
  assert.equal(requested, false);
  assert.match(error, /--timeout-ms requires --wait or --download/);
});

test("run JSON remains empty when bundle download fails", async () => {
  let stdout = "";
  const code = await executeCli([
    "run", "./video.mp4", "--output", "video.web", "--download", "./job.zip", "--json",
  ], {
    createClient: () => ({
      jobs: {
        create: async () => submitted(),
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    downloadBundle: async () => { throw new Error("integrity failure"); },
    writeStdout: (text) => { stdout += text; },
    writeStderr: () => {},
  });
  assert.equal(code, 9);
  assert.equal(stdout, "");
});

test("run validates required output before constructing a client request", async () => {
  let created = false;
  let error = "";
  const code = await executeCli(["run", "./video.mp4"], {
    createClient: () => ({
      jobs: {
        create: async () => { created = true; throw new Error("must not be called"); },
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    writeStderr: (text) => { error += text; },
  });
  assert.equal(code, 2);
  assert.equal(created, false);
  assert.doesNotMatch(error, /MEDIARUNTIME_API_KEY=.*|sk_/);
});

test("run attaches bounded privacy redaction to a still-image output", async () => {
  let createParams;
  const code = await executeCli([
    "run", "./people.jpg",
    "--preset", "image_multi_v1",
    "--privacy-detector", "face",
    "--privacy-detector", "text",
    "--privacy-style", "pixelate",
    "--privacy-failure-mode", "fail_closed",
    "--privacy-min-confidence", "0.72",
    "--privacy-sample-interval", "1.5",
    "--privacy-max-frames", "24",
    "--privacy-padding", "0.2",
  ], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => ({
          publicPresets: ["image_multi_v1"],
          presets: {
            image_multi_v1: { outputType: "image" },
          },
          outputAliases: {},
        }),
      },
      jobs: { create: async (params) => { createParams = params; return submitted(); } },
    }),
    writeStdout: () => {},
    writeStderr: (text) => { throw new Error(text); },
  });

  assert.equal(code, 0);
  assert.equal(createParams.outputs.length, 1);
  for (const output of createParams.outputs) {
    assert.deepEqual(output.privacyRedaction, {
      detectors: ["face", "text"],
      style: "pixelate",
      failureMode: "fail_closed",
      minConfidence: 0.72,
      sampleIntervalSec: 1.5,
      maxFrames: 24,
      boxPaddingRatio: 0.2,
    });
  }
  assert.equal(createParams.outputs[0].preset, "image_multi_v1");
});

test("run rejects video privacy redaction before upload or API submission", async () => {
  let requested = false;
  let error = "";
  const code = await executeCli([
    "run", "./people.mp4", "--output", "video.web", "--privacy-detector", "face",
  ], {
    createClient: () => ({ jobs: { create: async () => { requested = true; } } }),
    writeStdout: () => {},
    writeStderr: (text) => { error += text; },
  });
  assert.equal(code, 2);
  assert.equal(requested, false);
  assert.match(error, /still-image inputs only/i);
});

test("run rejects incomplete or invalid privacy controls locally", async () => {
  for (const args of [
    ["run", "./video.mp4", "--output", "video.web", "--privacy-style", "blur"],
    ["run", "./video.mp4", "--output", "video.web", "--privacy-detector", "person"],
    ["run", "./video.mp4", "--output", "video.web", "--privacy-detector", "face", "--privacy-detector", "face"],
    ["run", "./video.mp4", "--output", "video.web", "--privacy-detector", "face", "--privacy-max-frames", "18001"],
  ]) {
    let requested = false;
    let error = "";
    const code = await executeCli(args, {
      createClient: () => ({ jobs: { create: async () => { requested = true; } } }),
      writeStdout: () => {},
      writeStderr: (text) => { error += text; },
    });
    assert.equal(code, 2);
    assert.equal(requested, false);
    assert.match(error, /privacy/i);
  }
});
