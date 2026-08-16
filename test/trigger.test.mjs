import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  parseTriggerArguments,
  runTriggerCommand,
  signSyntheticWebhook,
} from "../dist/cli.js";

const NOW_MS = 1_786_766_400_000;
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const SECRET = "whsec_local_test_secret";

function testDependencies(overrides = {}) {
  const calls = [];
  const output = [];
  return {
    calls,
    output,
    dependencies: {
      env: { MEDIARUNTIME_WEBHOOK_SECRET: SECRET },
      now: () => NOW_MS,
      randomUUID: () => UUID,
      randomBytes: (size) => new Uint8Array(size).fill(7),
      readFile: async () => {
        throw new Error("unexpected secret file read");
      },
      writeStdout: (text) => output.push(text),
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response(null, { status: 204 });
      },
      ...overrides,
    },
  };
}

function header(init, name) {
  return new Headers(init.headers).get(name);
}

test("posts exact signed bytes directly to the explicit loopback endpoint", async () => {
  const harness = testDependencies();
  const exitCode = await runTriggerCommand(
    [
      "job.completed",
      "--to",
      "http://127.0.0.1:3000/webhooks/mediaruntime",
      "--job-id",
      "job_known",
      "--account-id",
      "acc_known",
    ],
    harness.dependencies,
  );

  assert.equal(exitCode, 0);
  assert.equal(harness.calls.length, 1);
  const [{ input, init }] = harness.calls;
  assert.equal(input, "http://127.0.0.1:3000/webhooks/mediaruntime");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.equal(header(init, "content-type"), "application/json");
  assert.equal(header(init, "x-transcoder-id"), `evt_cli_${UUID}`);
  assert.equal(header(init, "x-transcoder-timestamp"), String(NOW_MS / 1000));

  const body = init.body;
  assert.equal(typeof body, "string");
  const payload = JSON.parse(body);
  assert.equal(payload.event_id, `evt_cli_${UUID}`);
  assert.equal(payload.job_id, "job_known");
  assert.equal(payload.account_id, "acc_known");
  assert.equal(payload.status, "COMPLETED");
  assert.equal(payload.delivery.bundle.type, "zip");
  assert.equal(payload.meta.synthetic, true);

  const timestamp = String(NOW_MS / 1000);
  const expected = createHmac("sha256", SECRET)
    .update(`${timestamp}.evt_cli_${UUID}.`)
    .update(body)
    .digest("hex");
  assert.equal(
    header(init, "x-transcoder-signature"),
    `t=${timestamp},v1=${expected}`,
  );
  assert.equal(harness.output.length, 1);
  assert.doesNotMatch(harness.output[0], /whsec_local_test_secret/);
});

test("supports only truthful emitted terminal event projections", async () => {
  const expected = new Map([
    ["job.completed", "COMPLETED"],
    ["job.failed", "FAILED"],
    ["job.rejected", "REJECTED"],
  ]);
  for (const [eventType, status] of expected) {
    const harness = testDependencies();
    await runTriggerCommand(
      [eventType, "--to", "http://localhost:3000/hook"],
      harness.dependencies,
    );
    const payload = JSON.parse(harness.calls[0].init.body);
    assert.equal(payload.status, status);
    assert.equal(payload.job_id, `job_cli_${UUID}`);
    if (status === "FAILED") assert.equal(payload.error.code, "SYNTHETIC_ENGINE_FAILED");
    if (status === "REJECTED") assert.equal(payload.error.code, "SYNTHETIC_REJECTED");
  }

  assert.throws(
    () => parseTriggerArguments(["job.processing", "--to", "http://localhost/hook"]),
    /Unsupported trigger event/,
  );
  assert.throws(
    () => parseTriggerArguments(["job.partial", "--to", "http://localhost/hook"]),
    /Unsupported trigger event/,
  );
});

test("accepts loopback only and rejects credentials before fetch", async () => {
  for (const destination of [
    "http://localhost:8080/hook",
    "http://localhost.:8080/hook",
    "http://127.99.4.2:8080/hook",
    "http://[::1]:8080/hook",
  ]) {
    assert.equal(parseTriggerArguments(["job.failed", "--to", destination]).destination.href, destination);
  }

  for (const destination of [
    "https://example.com/hook",
    "http://localhost.example.com/hook",
    "http://user:password@localhost/hook",
    "file:///tmp/hook",
  ]) {
    const harness = testDependencies();
    await assert.rejects(
      runTriggerCommand(["job.completed", "--to", destination], harness.dependencies),
    );
    assert.equal(harness.calls.length, 0);
  }
});

test("reads an explicit secret file without exposing either secret", async () => {
  const fileSecret = "whsec_from_restricted_file";
  const reads = [];
  const harness = testDependencies({
    readFile: async (path, encoding) => {
      reads.push([path, encoding]);
      return `${fileSecret}\n`;
    },
  });
  await runTriggerCommand(
    [
      "job.rejected",
      "--to",
      "http://localhost:3000/hook",
      "--secret-file",
      "/tmp/local-webhook-secret",
    ],
    harness.dependencies,
  );

  assert.deepEqual(reads, [["/tmp/local-webhook-secret", "utf8"]]);
  const init = harness.calls[0].init;
  const timestamp = header(init, "x-transcoder-timestamp");
  const eventId = header(init, "x-transcoder-id");
  const expected = createHmac("sha256", fileSecret)
    .update(`${timestamp}.${eventId}.`)
    .update(init.body)
    .digest("hex");
  assert.equal(header(init, "x-transcoder-signature"), `t=${timestamp},v1=${expected}`);
  assert.doesNotMatch(harness.output.join(""), /whsec_/);
});

test("secure generation is explicit and prints only the newly generated secret", async () => {
  const harness = testDependencies({ env: {} });
  await runTriggerCommand(
    ["job.completed", "--to", "http://localhost:3000/hook", "--generate-secret"],
    harness.dependencies,
  );

  const generated = Buffer.alloc(32, 7).toString("base64url");
  assert.match(harness.output[0], new RegExp(`${generated}$`, "m"));
  const init = harness.calls[0].init;
  const expected = createHmac("sha256", generated)
    .update(`${header(init, "x-transcoder-timestamp")}.${header(init, "x-transcoder-id")}.`)
    .update(init.body)
    .digest("hex");
  assert.equal(
    header(init, "x-transcoder-signature"),
    `t=${header(init, "x-transcoder-timestamp")},v1=${expected}`,
  );
});

test("requires a secret, does not follow redirects, and rejects non-2xx responses", async () => {
  const missing = testDependencies({ env: {} });
  await assert.rejects(
    runTriggerCommand(
      ["job.completed", "--to", "http://localhost:3000/hook"],
      missing.dependencies,
    ),
    /MEDIARUNTIME_WEBHOOK_SECRET/,
  );
  assert.equal(missing.calls.length, 0);

  for (const status of [302, 400, 500]) {
    const harness = testDependencies({
      fetch: async (_input, init) => {
        assert.equal(init.redirect, "manual");
        return new Response(null, { status });
      },
    });
    await assert.rejects(
      runTriggerCommand(
        ["job.completed", "--to", "http://localhost:3000/hook"],
        harness.dependencies,
      ),
      new RegExp(`HTTP ${status}`),
    );
  }
});

test("signature helper authenticates exactly the returned body bytes", () => {
  const signed = signSyntheticWebhook(
    { unicode: "한글", nested: { value: 7 } },
    { eventId: "evt_exact", timestamp: 1234, secret: "exact-secret" },
  );
  const expected = createHmac("sha256", "exact-secret")
    .update("1234.evt_exact.")
    .update(Buffer.from(signed.body, "utf8"))
    .digest("hex");
  assert.equal(
    new Headers(signed.headers).get("x-transcoder-signature"),
    `t=1234,v1=${expected}`,
  );
});

test("JSON mode emits one stable result and rejects generated-secret mode", async () => {
  const harness = testDependencies();
  await runTriggerCommand(
    ["job.completed", "--to", "http://localhost:3000/hook", "--json"],
    harness.dependencies,
  );
  assert.equal(harness.output.length, 1);
  assert.deepEqual(JSON.parse(harness.output[0]), {
    eventId: `evt_cli_${UUID}`,
    type: "job.completed",
    jobId: `job_cli_${UUID}`,
    status: "COMPLETED",
    destination: "http://localhost:3000/hook",
    httpStatus: 204,
  });
  assert.throws(
    () => parseTriggerArguments([
      "job.completed", "--to", "http://localhost/hook", "--generate-secret", "--json",
    ]),
    /mutually exclusive/,
  );
});
