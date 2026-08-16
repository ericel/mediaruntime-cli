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
  assert.match(stderr, /Uploading local source and creating job/);
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
