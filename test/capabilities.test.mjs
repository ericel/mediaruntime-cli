import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCli } from "../dist/cli.js";

function capabilities() {
  return {
    capabilities: { visual: "a video or image stream" },
    outputTypes: { dash: ["timeline"] },
    presetOverrides: {},
    publicPresets: ["dash_ladder_v1", "webm_vp9_1080p"],
    presets: {
      dash_ladder_v1: {
        outputType: "dash",
        sourceKinds: ["video"],
        baseTier: "standard",
        description: "Adaptive MPEG-DASH ladder.",
        artifacts: ["MPD manifest", "fragmented MP4 segments"],
        codec: "h264+aac",
        container: "dash",
      },
      webm_vp9_1080p: {
        outputType: "webm",
        sourceKinds: ["video"],
        baseTier: "premium",
        description: "VP9 and Opus WebM.",
        artifacts: ["VP9/Opus WebM"],
        codec: "vp9+opus",
        container: "webm",
      },
    },
    features: {
      moderation: { modes: ["report", "block"] },
      smart_crop: { algorithm: "saliency" },
    },
    outputAliases: {
      "video.streaming": {
        type: "hls",
        preset: "hls_ladder_v1",
        tier: "standard",
        artifacts: ["HLS master playlist"],
        output: { type: "hls", preset: "hls_ladder_v1" },
      },
    },
    notes: [],
  };
}

function dependencies(writes, seenOptions) {
  return {
    createClient: (options) => {
      seenOptions.push(options);
      return {
        capabilities: { retrieve: async () => capabilities() },
        jobs: {
          create: async () => { throw new Error("not used"); },
          list: async () => { throw new Error("not used"); },
          get: async () => { throw new Error("not used"); },
        },
      };
    },
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  };
}

test("capabilities are readable without a credential and summarize aliases and features", async () => {
  const writes = { stdout: "", stderr: "" };
  const seenOptions = [];
  const previous = process.env.MEDIARUNTIME_API_KEY;
  delete process.env.MEDIARUNTIME_API_KEY;
  try {
    const code = await executeCli(["capabilities"], dependencies(writes, seenOptions));
    assert.equal(code, 0);
  } finally {
    if (previous === undefined) delete process.env.MEDIARUNTIME_API_KEY;
    else process.env.MEDIARUNTIME_API_KEY = previous;
  }
  assert.deepEqual(seenOptions, [{}]);
  assert.match(writes.stdout, /Public presets: 2/);
  assert.match(writes.stdout, /moderation, smart_crop/);
  assert.match(writes.stdout, /video\.streaming\s+hls\s+hls_ladder_v1/);
  assert.equal(writes.stderr, "");
});

test("presets list exposes only the ordered public catalog in JSON", async () => {
  const writes = { stdout: "", stderr: "" };
  const code = await executeCli(["presets", "list", "--json"], dependencies(writes, []));
  assert.equal(code, 0);
  const result = JSON.parse(writes.stdout);
  assert.deepEqual(result.presets.map((preset) => preset.name), [
    "dash_ladder_v1",
    "webm_vp9_1080p",
  ]);
  assert.equal(result.presets[0].outputType, "dash");
  assert.deepEqual(result.presets[0].artifacts, ["MPD manifest", "fragmented MP4 segments"]);
});

test("presets list rejects unsupported options before a request", async () => {
  const writes = { stdout: "", stderr: "" };
  let requested = false;
  const code = await executeCli(["presets", "list", "--tier", "premium"], {
    createClient: () => ({
      capabilities: {
        retrieve: async () => { requested = true; throw new Error("must not request"); },
      },
      jobs: {
        create: async () => { throw new Error("not used"); },
        list: async () => { throw new Error("not used"); },
        get: async () => { throw new Error("not used"); },
      },
    }),
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  });
  assert.equal(code, 2);
  assert.equal(requested, false);
  assert.match(writes.stderr, /Unknown presets list option/);
});
