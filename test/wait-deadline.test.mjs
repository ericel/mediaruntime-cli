import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MediaRuntime } from "@mediaruntime/node";
import { executeCli } from "../dist/cli.js";

for (const scenario of ["pending request", "poll delay", "retry delay", "pending body", "terminal completion"]) {
  test(`CLI with installed SDK: ${scenario}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    t.mock.method(Math, "random", () => 0.5);
    let submissions = 0;
    let downloads = 0;
    const requests = [];
    const writes = { stdout: "", stderr: "" };
    const media = new MediaRuntime({
      apiKey: "test-deadline",
      baseUrl: "https://example.test",
      timeoutMs: 10_000,
      maxRetries: 2,
      fetch: async (_url, init) => {
        if (init.method === "POST") {
          submissions += 1;
          return Response.json({ job_id: "job_cli_deadline", status: "QUEUED", tier: "standard" });
        }
        assert.equal(init.method, "GET");
        requests.push(init.signal);
        if (scenario === "pending request") {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          });
        }
        if (scenario === "retry delay") {
          return Response.json({ detail: "busy" }, { status: 503, headers: { "Retry-After": "60" } });
        }
        if (scenario === "pending body") {
          return { ok: true, status: 200, text: () => new Promise(() => {}) };
        }
        const status = scenario === "terminal completion" ? "COMPLETED" : "PROCESSING";
        return Response.json({
          job_id: "job_cli_deadline", status,
          bundle: { available: true, download_url: "https://example.test/bundle.zip" },
        });
      },
    });
    const result = { state: "pending" };
    const run = executeCli([
      "run", "https://example.test/video.mp4", "--recipe", "web-video",
      "--download", "./unused-test-bundle.zip", "--timeout-ms", "100", "--json",
    ], {
      createClient: () => media,
      downloadBundle: async () => { downloads += 1; },
      writeStdout: (text) => { writes.stdout += text; },
      writeStderr: (text) => { writes.stderr += text; },
    });
    run.then((code) => Object.assign(result, { state: "done", code }));
    await nextTurn();
    assert.equal(submissions, 1);
    assert.equal(requests.length, 1);
    if (scenario === "terminal completion") {
      assert.deepEqual(result, { state: "done", code: 0 });
      assert.equal(JSON.parse(writes.stdout).status, "COMPLETED");
      assert.equal(writes.stderr, "");
      assert.equal(downloads, 1);
    } else {
      assert.equal(result.state, "pending");
      t.mock.timers.tick(100);
      await nextTurn();
      assert.deepEqual(result, { state: "done", code: 7 });
      assert.equal(downloads, 0);
      assert.equal(writes.stdout, "");
      assert.match(JSON.parse(writes.stderr).error.message, /within 100ms/);
      if (scenario === "pending request" || scenario === "pending body") {
        assert.equal(requests[0].aborted, true);
      }
    }
    t.mock.timers.tick(60_000);
    await nextTurn();
    assert.equal(submissions, 1);
    assert.equal(requests.length, 1);
  });
}
