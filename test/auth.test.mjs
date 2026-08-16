import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  executeCli,
  runAuthStatusCommand,
  runLoginCommand,
  runLogoutCommand,
} from "../dist/cli.js";

class MemoryCredentialStore {
  credential = null;
  deleted = false;

  async get() { return this.credential; }
  async set(value) { this.credential = value; }
  async delete() { this.credential = null; this.deleted = true; }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("browser login uses PKCE, stores the key, and never prints it", async () => {
  const credentialStore = new MemoryCredentialStore();
  const verifier = "v".repeat(64);
  const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
  const apiKey = "sk_live_acc_1_key_cli_super_secret";
  const requests = [];
  let tokenPolls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init.body));
    requests.push({ url, body, headers: init.headers });
    if (url.endsWith("/start")) {
      assert.equal(body.codeChallenge, expectedChallenge);
      assert.equal("codeVerifier" in body, false);
      return json({
        deviceCode: "device_" + "d".repeat(40),
        userCode: "ABCDE-23456",
        verificationUri: "https://mediaruntime.com/cli/authorize",
        verificationUriComplete: "https://mediaruntime.com/cli/authorize?device_code=signed.request&user_code=ABCDE-23456",
        expiresIn: 600,
        interval: 1,
      });
    }
    if (url.endsWith("/token")) {
      tokenPolls += 1;
      assert.equal(body.codeVerifier, verifier);
      if (tokenPolls === 1) return json({ error: "authorization_pending", detail: "Waiting" }, 428);
      return json({ apiKey, accountId: "acc_1", keyId: "key_cli", credentialType: "cli" });
    }
    if (url.endsWith("/status")) {
      assert.equal(init.headers["X-API-Key"], apiKey);
      return json({ status: "authenticated", accountId: "acc_1", keyId: "key_cli", credentialType: "cli" });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  let output = "";
  let browserUrl = "";
  let clock = 1_000;
  try {
    assert.equal(await runLoginCommand([], "https://mediaruntime.com", {
      credentialStore,
      randomVerifier: () => verifier,
      openBrowser: async (url) => { browserUrl = url; },
      sleep: async (milliseconds) => { clock += milliseconds; },
      now: () => clock,
      writeStdout: (text) => { output += text; },
    }), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(browserUrl, /\/cli\/authorize/);
  assert.match(output, /Confirm code: ABCDE-23456/);
  assert.match(output, /Logged in/);
  assert.equal(output.includes(apiKey), false);
  assert.equal(credentialStore.credential.apiKey, apiKey);
  assert.equal(requests.some((request) => JSON.stringify(request).includes(apiKey) && request.url.endsWith("/start")), false);
});

test("environment API key takes precedence over a stored login", async () => {
  const credentialStore = new MemoryCredentialStore();
  credentialStore.credential = {
    apiKey: "sk_stored",
    accountId: "acc_stored",
    keyId: "key_stored",
    baseUrl: "https://mediaruntime.com",
    createdAt: new Date(0).toISOString(),
  };
  const original = process.env.MEDIARUNTIME_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.MEDIARUNTIME_API_KEY = "sk_environment";
  globalThis.fetch = async (_input, init) => {
    assert.equal(init.headers["X-API-Key"], "sk_environment");
    return json({ status: "authenticated", accountId: "acc_env", keyId: "key_env", credentialType: "api_key" });
  };
  let output = "";
  try {
    assert.equal(await runAuthStatusCommand(["--json"], "https://mediaruntime.com", {
      credentialStore,
      writeStdout: (text) => { output += text; },
    }), 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (original === undefined) delete process.env.MEDIARUNTIME_API_KEY;
    else process.env.MEDIARUNTIME_API_KEY = original;
  }
  assert.equal(JSON.parse(output).source, "environment");
  assert.equal(JSON.parse(output).accountId, "acc_env");
});

test("normal commands use the stored login when the environment is empty", async () => {
  const credentialStore = new MemoryCredentialStore();
  credentialStore.credential = {
    apiKey: "sk_stored",
    accountId: "acc_1",
    keyId: "key_1",
    baseUrl: "https://mediaruntime.com",
    createdAt: new Date(0).toISOString(),
  };
  const original = process.env.MEDIARUNTIME_API_KEY;
  delete process.env.MEDIARUNTIME_API_KEY;
  let receivedOptions;
  try {
    assert.equal(await executeCli(["jobs", "list", "--limit", "1"], {
      credentialStore,
      createClient: (options) => {
        receivedOptions = options;
        return { jobs: { list: async () => ({ jobs: [], nextCursor: null }) } };
      },
      writeStdout: () => {},
      writeStderr: () => {},
    }), 0);
  } finally {
    if (original === undefined) delete process.env.MEDIARUNTIME_API_KEY;
    else process.env.MEDIARUNTIME_API_KEY = original;
  }
  assert.equal(receivedOptions.apiKey, "sk_stored");
});

test("logout revokes the stored CLI key before deleting it", async () => {
  const credentialStore = new MemoryCredentialStore();
  credentialStore.credential = {
    apiKey: "sk_cli_secret",
    accountId: "acc_1",
    keyId: "key_1",
    baseUrl: "https://mediaruntime.com",
    createdAt: new Date(0).toISOString(),
  };
  const originalFetch = globalThis.fetch;
  let revoked = false;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/revoke$/);
    assert.equal(init.headers["X-API-Key"], "sk_cli_secret");
    revoked = true;
    return json({ status: "revoked", keyId: "key_1" });
  };
  try {
    assert.equal(await runLogoutCommand([], "https://mediaruntime.com", {
      credentialStore,
      writeStdout: () => {},
    }), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(revoked, true);
  assert.equal(credentialStore.deleted, true);
});
