import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCli } from "../dist/cli.js";

function details(status = "COMPLETED") {
  return {
    id: "job_123",
    status,
    tier: { requested: "standard", required: "standard", effective: "standard", billed: "standard", reasons: [] },
    usage: { unitsTotal: 2 },
    billing: {
      status: "PAID",
      currency: "USD",
      unitPriceCents: 1,
      finalUnits: 2,
      finalAmountCents: 2,
      estimatedUnits: 2,
      estimatedAmountCents: 2,
    },
    bundle: {
      available: status === "COMPLETED",
      downloadUrl: status === "COMPLETED" ? "https://signed.example.test/bundle?token=secret" : null,
      expiresAt: "2026-08-17T00:00:00Z",
      sizeBytes: 2048,
      sha256: "b".repeat(64),
      retentionDays: 7,
    },
    media: null,
    metadata: { asset_id: "asset_123" },
    error: status === "REJECTED" ? "moderation rejected" : null,
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:01Z",
    startedAt: null,
    completedAt: status === "COMPLETED" ? "2026-08-16T00:00:01Z" : null,
  };
}

function dependencies(jobs, writes) {
  return {
    createClient: () => ({ jobs: { create: async () => { throw new Error("not used"); }, ...jobs } }),
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  };
}

test("jobs list forwards filters and produces machine-readable output", async () => {
  let params;
  const writes = { stdout: "", stderr: "" };
  const page = {
    jobs: [{
      id: "job_123",
      status: "COMPLETED",
      tierBilled: "standard",
      unitsTotal: 2,
      amountCents: 2,
      currency: "USD",
      bundleAvailable: true,
      createdAt: "2026-08-16T00:00:00Z",
      updatedAt: "2026-08-16T00:00:01Z",
    }],
    nextCursor: "job_123",
  };
  const code = await executeCli([
    "jobs", "list", "--status", "completed", "--limit", "10", "--cursor", "job_000", "--json",
  ], dependencies({
    list: async (value) => { params = value; return page; },
    get: async () => { throw new Error("not used"); },
  }, writes));
  assert.equal(code, 0);
  assert.deepEqual(params, { status: "COMPLETED", limit: 10, cursor: "job_000" });
  assert.deepEqual(JSON.parse(writes.stdout), page);
  assert.equal(writes.stderr, "");
});

test("jobs list renders a safe human table", async () => {
  const writes = { stdout: "", stderr: "" };
  const code = await executeCli(["jobs", "list"], dependencies({
    list: async () => ({
      jobs: [{
        id: "job_123",
        status: "COMPLETED",
        tierBilled: "standard",
        unitsTotal: 2,
        amountCents: 2,
        currency: "USD",
        bundleAvailable: true,
        createdAt: null,
        updatedAt: "2026-08-16T00:00:01Z",
      }],
      nextCursor: null,
    }),
    get: async () => { throw new Error("not used"); },
  }, writes));
  assert.equal(code, 0);
  assert.match(writes.stdout, /ID\s+STATUS\s+TIER/);
  assert.match(writes.stdout, /job_123\s+COMPLETED\s+standard/);
});

test("jobs get downloads only the completed canonical bundle and redacts its URL", async () => {
  const writes = { stdout: "", stderr: "" };
  let requestedId;
  let download;
  const deps = dependencies({
    list: async () => { throw new Error("not used"); },
    get: async (jobId) => { requestedId = jobId; return details(); },
  }, writes);
  deps.downloadBundle = async (url, destination, options) => {
    download = { url, destination, options };
  };
  const code = await executeCli([
    "jobs", "get", "job_123", "--download", "./job_123.zip",
  ], deps);
  assert.equal(code, 0);
  assert.equal(requestedId, "job_123");
  assert.deepEqual(download, {
    url: "https://signed.example.test/bundle?token=secret",
    destination: "./job_123.zip",
    options: { force: false, expectedSizeBytes: 2048, expectedSha256: "b".repeat(64) },
  });
  assert.match(writes.stdout, /Downloaded bundle to \.\/job_123\.zip/);
  assert.doesNotMatch(writes.stdout, /signed\.example|token=secret/);
});

test("jobs get JSON omits signed URL and rejected jobs exit non-success", async () => {
  const writes = { stdout: "", stderr: "" };
  const code = await executeCli(["jobs", "get", "job_123", "--json"], dependencies({
    list: async () => { throw new Error("not used"); },
    get: async () => details("REJECTED"),
  }, writes));
  assert.equal(code, 6);
  const projected = JSON.parse(writes.stdout);
  assert.equal(projected.status, "REJECTED");
  assert.equal("downloadUrl" in projected.bundle, false);
  assert.doesNotMatch(writes.stdout, /signed\.example|token=secret/);
});

test("jobs get JSON remains empty when bundle download fails", async () => {
  const writes = { stdout: "", stderr: "" };
  const deps = dependencies({
    list: async () => { throw new Error("not used"); },
    get: async () => details(),
  }, writes);
  deps.downloadBundle = async () => { throw new Error("size mismatch"); };
  const code = await executeCli([
    "jobs", "get", "job_123", "--download", "./job.zip", "--json",
  ], deps);
  assert.equal(code, 9);
  assert.equal(writes.stdout, "");
});
