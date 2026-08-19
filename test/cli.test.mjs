import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  AuthenticationError,
  JobWaitTimeoutError,
  MediaRuntimeConnectionError,
} from "@mediaruntime/node";
import { downloadBundleAtomically, executeCli } from "../dist/cli.js";

test("atomic bundle download refuses overwrite unless force is explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediaruntime-cli-"));
  const destination = join(directory, "job.zip");
  const originalFetch = globalThis.fetch;
  let payload = Buffer.from("zip-one");
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(payload, {
      status: 200,
      headers: { "Content-Type": "application/zip" },
    });
  };
  try {
    await downloadBundleAtomically(
      "https://signed.example.test/bundle?token=secret",
      destination,
      {
        force: false,
        expectedSizeBytes: payload.length,
        expectedSha256: createHash("sha256").update(payload).digest("hex"),
      },
    );
    assert.equal(requestedUrl, "https://signed.example.test/bundle?token=secret");
    assert.deepEqual(await readFile(destination), Buffer.from("zip-one"));
    assert.deepEqual(await readdir(directory), ["job.zip"]);

    await assert.rejects(
      downloadBundleAtomically("https://signed.example.test/other", destination, { force: false }),
      /Refusing to overwrite existing file/,
    );
    assert.deepEqual(await readFile(destination), Buffer.from("zip-one"));

    payload = Buffer.from("zip-two");
    await downloadBundleAtomically(
      "https://signed.example.test/bundle?token=replacement",
      destination,
      {
        force: true,
        expectedSizeBytes: payload.length,
        expectedSha256: createHash("sha256").update(payload).digest("hex"),
      },
    );
    assert.deepEqual(await readFile(destination), Buffer.from("zip-two"));
    assert.deepEqual(await readdir(directory), ["job.zip"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle integrity mismatch removes the temporary file and preserves destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediaruntime-cli-integrity-"));
  const destination = join(directory, "job.zip");
  await writeFile(destination, "old-zip");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("new-zip", { status: 200 });
  try {
    await assert.rejects(
      downloadBundleAtomically("https://signed.example.test/bundle", destination, {
        force: true,
        expectedSizeBytes: 999,
        expectedSha256: "0".repeat(64),
      }),
      /Bundle size mismatch/,
    );
    assert.equal(await readFile(destination, "utf8"), "old-zip");
    assert.deepEqual(await readdir(directory), ["job.zip"]);

    await assert.rejects(
      downloadBundleAtomically("https://signed.example.test/bundle", join(directory, "sha.zip"), {
        force: false,
        expectedSizeBytes: Buffer.byteLength("new-zip"),
        expectedSha256: "0".repeat(64),
      }),
      /Bundle SHA-256 mismatch/,
    );
    assert.deepEqual(await readdir(directory), ["job.zip"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle download failure does not expose the signed URL or leave a partial file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediaruntime-cli-failure-"));
  const destination = join(directory, "job.zip");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("network failed for https://signed.example.test/?token=secret");
  };
  try {
    await assert.rejects(
      downloadBundleAtomically(
        "https://signed.example.test/bundle?token=secret",
        destination,
        { force: false },
      ),
      (error) => error instanceof Error &&
        error.message === "Bundle download failed before receiving a response",
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("trigger dispatch does not construct an API client", async () => {
  let constructed = false;
  let output = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    const code = await executeCli([
      "trigger", "job.failed",
      "--to", "http://127.0.0.1:3000/webhooks/mediaruntime",
      "--generate-secret",
    ], {
      createClient: () => {
        constructed = true;
        throw new Error("must not construct API client");
      },
      writeStdout: (text) => { output += text; },
      writeStderr: () => {},
    });
    assert.equal(code, 0);
    assert.equal(constructed, false);
    assert.match(output, /Generated webhook secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("central entrypoint maps usage and trigger response failures", async () => {
  let clientConstructed = false;
  let stderr = "";
  assert.equal(await executeCli([
    "--base-url", "http://example.com", "jobs", "list", "--json",
  ], {
    createClient: () => {
      clientConstructed = true;
      throw new Error("must not construct client");
    },
    writeStderr: (text) => { stderr += text; },
  }), 2);
  assert.equal(clientConstructed, false);
  assert.equal(JSON.parse(stderr).error.exitCode, 2);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 409 });
  try {
    delete process.env.MEDIARUNTIME_WEBHOOK_SECRET;
    assert.equal(await executeCli([
      "trigger", "job.completed", "--to", "http://localhost:3000/hook",
    ], {
      writeStdout: () => {},
      writeStderr: () => {},
    }), 2);
    process.env.MEDIARUNTIME_WEBHOOK_SECRET = "whsec_cli_test";
    assert.equal(await executeCli([
      "trigger", "job.completed", "--to", "http://localhost:3000/hook",
    ], {
      writeStdout: () => {},
      writeStderr: () => {},
    }), 8);
  } finally {
    delete process.env.MEDIARUNTIME_WEBHOOK_SECRET;
    globalThis.fetch = originalFetch;
  }
});

test("npm-style binary symlink executes the CLI entrypoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediaruntime-cli-bin-"));
  const binary = join(directory, "mediaruntime");
  try {
    await symlink(resolve("dist/cli.js"), binary);
    const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "1.2.0\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("central entrypoint maps SDK authentication, connection, and wait errors", async () => {
  const cases = [
    [new AuthenticationError("Unauthorized", { status: 401, code: "unauthorized" }), 3],
    [new MediaRuntimeConnectionError("network unavailable"), 5],
    [new JobWaitTimeoutError(1000, null), 7],
  ];
  for (const [failure, expected] of cases) {
    let stderr = "";
    const code = await executeCli(["jobs", "list", "--json"], {
      createClient: () => ({
        jobs: {
          create: async () => { throw new Error("not used"); },
          get: async () => { throw new Error("not used"); },
          list: async () => { throw failure; },
        },
      }),
      writeStderr: (text) => { stderr += text; },
    });
    assert.equal(code, expected);
    assert.equal(JSON.parse(stderr).error.exitCode, expected);
  }
});
