import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaRuntime } from "@mediaruntime/node";
import { executeCli } from "../dist/cli.js";

for (const selection of [["--output", "video.web"], ["--recipe", "web-video"]]) {
  for (const suppress of [false, true]) {
    test(`${selection.join(" ")} forwards opt-out=${suppress} through the installed SDK`, async () => {
      let body;
      let stdout = "";
      const media = new MediaRuntime({ apiKey: "test", fetch: async (_url, options) => {
        if (options.method === "POST") {
          body = JSON.parse(options.body);
          return Response.json({ job_id: "job_test", status: "QUEUED", tier: "standard" });
        }
        return Response.json({ job_id: "job_test", status: "COMPLETED", deliver_webhook: !suppress });
      } });
      const exit = await executeCli([
        "run", "https://example.test/video.mp4", ...selection,
        ...(suppress ? ["--no-webhook"] : []), "--wait", "--json",
      ], {
        createClient: () => media,
        writeStdout: (text) => { stdout += text; },
        writeStderr: (text) => assert.fail(text),
      });
      assert.equal(exit, 0);
      assert.equal(body.deliver_webhook, suppress ? false : undefined);
      assert.equal(Object.hasOwn(body, "deliver_webhook"), suppress);
      assert.equal(JSON.parse(stdout).deliverWebhook, !suppress);
    });
  }
}

test("local upload, opted-out submission, polling and bundle download work together", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-cli-optout-"));
  const source = join(root, "input.mp4");
  await writeFile(source, "local media fixture");
  const methods = [];
  let download;
  const media = new MediaRuntime({ apiKey: "test", fetch: async (input, options) => {
    const url = new URL(input);
    methods.push(options.method);
    if (url.pathname.endsWith("/upload-url")) {
      return Response.json({ upload_url: "https://storage.example.test/upload", file_uri: "gs://account-uploads/input.mp4", upload_headers: {} });
    }
    if (options.method === "PUT") {
      assert.equal(new Headers(options.headers).has("X-API-Key"), false);
      assert.equal(await new Response(options.body).text(), "local media fixture");
      return new Response(null, { status: 200 });
    }
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.source, "gs://account-uploads/input.mp4");
      assert.equal(body.deliver_webhook, false);
      return Response.json({ job_id: "job_test", status: "QUEUED", tier: "standard" });
    }
    return Response.json({ job_id: "job_test", status: "COMPLETED", deliver_webhook: false,
      bundle: { available: true, download_url: "https://example.test/bundle.zip?token=private" } });
  } });
  try {
    const exit = await executeCli(["run", source, "--output", "video.web", "--no-webhook", "--download", join(root, "out.zip")], {
      createClient: () => media,
      writeStdout: (text) => assert.doesNotMatch(text, /token=private/),
      writeStderr: (text) => assert.fail(text),
      downloadBundle: async (url) => { download = url; },
    });
    assert.equal(exit, 0);
    assert.deepEqual(methods, ["POST", "PUT", "POST", "GET"]);
    assert.equal(download, "https://example.test/bundle.zip?token=private");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("jobs get JSON exposes the saved policy", async () => {
  let stdout = "";
  const media = new MediaRuntime({ apiKey: "test", fetch: async () => Response.json({ job_id: "job_test", status: "COMPLETED", deliver_webhook: false }) });
  assert.equal(await executeCli(["jobs", "get", "job_test", "--json"], {
    createClient: () => media,
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => assert.fail(text),
  }), 0);
  assert.equal(JSON.parse(stdout).deliverWebhook, false);
});
