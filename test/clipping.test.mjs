import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeCli } from "../dist/cli.js";

function dependencies(create, supportsClipping = true) {
  return {
    createClient: () => ({
      jobs: { create, ...(supportsClipping ? { getClipCandidates: async () => ({}) } : {}) },
      capabilities: { retrieve: async () => ({
        publicPresets: ["video_clip_v1", "clip_candidates_v1"],
        presets: { video_clip_v1: { outputType: "mp4" }, clip_candidates_v1: { outputType: "frames" } },
      }) },
    }),
    writeStdout: () => {}, writeStderr: () => {},
  };
}
const receipt = { id: "job_clip", status: "QUEUED", tier: "standard", outputs: [] };

test("clip CLI reads a portable plan and preserves source caption timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mr-clip-cli-"));
  try {
    const file = join(directory, "plan.json");
    await writeFile(file, JSON.stringify({ schema_version: 1, transcript: [
      { start_time_sec: 12, end_time_sec: 15, text: "Keep this timing." },
    ] }));
    let params;
    const code = await executeCli(["run", "https://example.test/source.mp4", "--preset", "video_clip_v1",
      "--clip-start", "11.5", "--clip-duration", "5", "--clip-layout", "vertical_blur",
      "--clip-transcript", file, "--clip-captions"], dependencies(async (value) => {
      params = value; return receipt;
    }));
    assert.equal(code, 0);
    assert.deepEqual(params.outputs[0].clip, {
      startTimeSec: 11.5, durationSec: 5, layout: "vertical_blur", burnCaptions: true,
      transcript: [{ startTimeSec: 12, endTimeSec: 15, text: "Keep this timing." }],
    });
  } finally { await rm(directory, { recursive: true }); }
});

test("clip analysis options reach the discovered preset", async () => {
  let params;
  const code = await executeCli(["run", "https://example.test/source.mp4", "--preset", "clip_candidates_v1",
    "--clip-min-duration", "10", "--clip-max-duration", "30", "--clip-count", "3", "--clip-keyword", "API"],
  dependencies(async (value) => { params = value; return receipt; }));
  assert.equal(code, 0);
  assert.deepEqual(params.outputs[0].clipAnalysis, {
    minDurationSec: 10, maxDurationSec: 30, maxCandidates: 3, keywords: ["API"],
  });
});

test("old SDK and invalid clip options fail before creating jobs", async () => {
  const cases = [
    ["--preset", "video_clip_v1", "--clip-duration", "4"],
    ["--preset", "video_clip_v1", "--clip-start", "0", "--clip-duration", "301"],
    ["--preset", "video_clip_v1", "--clip-start", "0", "--clip-duration", "4", "--clip-captions"],
    ["--preset", "clip_candidates_v1", "--clip-min-duration", "40", "--clip-max-duration", "20"],
    ["--preset", "video_clip_v1", "--clip-start", "0", "--clip-duration", "4"],
  ];
  for (const [index, options] of cases.entries()) {
    let submitted = false;
    const code = await executeCli(["run", "https://example.test/source.mp4", ...options],
      dependencies(async () => { submitted = true; return receipt; }, index < cases.length - 1));
    assert.notEqual(code, 0);
    assert.equal(submitted, false);
  }
});

test("SRT and VTT attachments share the browser's source-time and plain-text convention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mr-clip-subtitles-"));
  try {
    for (const [extension, text] of [
      ["srt", "\uFEFF1\r\n00:00:12,000 --> 00:00:15,000\r\n<b>Keep &amp; share.</b>\r\n"],
      ["vtt", "WEBVTT\n\nNOTE testing\n\ncue-1\n00:12.000 --> 00:15.000 align:start\n<v Speaker>Keep &amp; share.</v>\n"],
    ]) {
      const file = join(directory, `captions.${extension}`);
      await writeFile(file, text);
      let params;
      const code = await executeCli(["run", "https://example.test/source.mp4", "--preset", "video_clip_v1",
        "--clip-start", "11", "--clip-duration", "5", "--clip-transcript", file, "--clip-captions"],
      dependencies(async (value) => { params = value; return receipt; }));
      assert.equal(code, 0);
      assert.deepEqual(params.outputs[0].clip.transcript, [{startTimeSec: 12, endTimeSec: 15, text: "Keep & share."}]);
    }
  } finally { await rm(directory, { recursive: true }); }
});

test("transcript errors fail as usage errors before creating any job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mr-clip-errors-"));
  try {
    const invalid = [
      ["null.json", "[null]"], ["format.json", "{"], ["empty.json", "[]"],
      ["order.json", JSON.stringify([{startTimeSec: 12,endTimeSec: 13,text:"A"},{startTimeSec: 1,endTimeSec: 2,text:"B"}])],
      ["range.json", JSON.stringify([{startTimeSec: 2,endTimeSec: 1,text:"A"}])],
      ["utf8.srt", Buffer.from([0xc3, 0x28])],
      ["header.vtt", "00:01.000 --> 00:02.000\nMissing header"],
      ["time.srt", "1\n00:61:00,000 --> 00:62:00,000\nInvalid time"],
      ["text.json", JSON.stringify([{startTimeSec: 1,endTimeSec: 2,text:"🎬".repeat(501)}])],
      ["size.json", " ".repeat(1024 * 1024 + 1)], ["wrong.txt", "[]"],
    ];
    for (const [name, content] of invalid) {
      const file = join(directory, name);
      await writeFile(file, content);
      let submitted = false;
      const code = await executeCli(["run", "https://example.test/source.mp4", "--preset", "video_clip_v1",
        "--clip-start", "0", "--clip-duration", "5", "--clip-transcript", file],
      dependencies(async () => { submitted = true; return receipt; }));
      assert.equal(code, 2, name);
      assert.equal(submitted, false, name);
    }
  } finally { await rm(directory, { recursive: true }); }
});

test("reused transcript reaches analysis without requesting another transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mr-clip-reuse-"));
  try {
    const file = join(directory, "captions.srt");
    await writeFile(file, "1\n00:00:01,000 --> 00:00:04,000\nLocal QA caption.\n");
    let params;
    const code = await executeCli(["run", "https://example.test/source.mp4", "--preset", "clip_candidates_v1",
      "--clip-min-duration", "1", "--clip-max-duration", "5", "--clip-transcript", file],
    dependencies(async (value) => { params = value; return receipt; }));
    assert.equal(code, 0);
    assert.deepEqual(params.outputs[0].clipAnalysis.transcript, [{startTimeSec: 1,endTimeSec: 4,text:"Local QA caption."}]);
  } finally { await rm(directory, { recursive: true }); }
});

test("built CLI and installed SDK serialize clipping through the real transport", async () => {
  const { MediaRuntime } = await import("@mediaruntime/node");
  const requests = [];
  const media = new MediaRuntime({ apiKey: "local-contract-test", fetch: async (url, options) => {
    assert.match(String(url), /\/v1\/jobs$/);
    requests.push(JSON.parse(options.body));
    return Response.json({job_id: "job_contract", status: "QUEUED", tier: "standard"});
  }});
  const transport = dependencies();
  const client = transport.createClient();
  transport.createClient = () => ({...client, jobs: media.jobs});
  const directory = await mkdtemp(join(tmpdir(), "mr-clip-transport-"));
  try {
    const file = join(directory, "captions.vtt");
    await writeFile(file, "WEBVTT\n\n00:01.000 --> 00:04.000\nSupplied caption.\n");
    assert.equal(await executeCli(["run", "https://example.test/source.mp4", "--preset", "clip_candidates_v1",
      "--clip-min-duration", "1", "--clip-max-duration", "5", "--clip-count", "2", "--clip-transcript", file], transport), 0);
    assert.deepEqual(requests[0].outputs[0].clip_analysis, {
      min_duration_sec: 1, max_duration_sec: 5, max_candidates: 2,
      transcript: [{start_time_sec: 1,end_time_sec: 4,text:"Supplied caption."}],
    });
    assert.equal(await executeCli(["run", "https://example.test/source.mp4", "--preset", "video_clip_v1",
      "--clip-start", "1", "--clip-duration", "4", "--clip-transcript", file, "--clip-captions"], transport), 0);
    assert.deepEqual(requests[1].outputs[0].clip, {
      start_time_sec: 1, duration_sec: 4, burn_captions: true,
      transcript: [{start_time_sec: 1,end_time_sec: 4,text:"Supplied caption."}],
    });
  } finally { await rm(directory, {recursive:true}); }
});
