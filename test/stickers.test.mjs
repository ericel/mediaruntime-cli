import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCli } from "../dist/cli.js";

const COLLECTION_ID = `stc_${"a".repeat(32)}`;

function collection(overrides = {}) {
  // Supply the complete SDK projection so render tests catch accidental wire-casing assumptions.
  return {
    collectionId: COLLECTION_ID,
    workspaceId: "acc_test",
    name: "Support chat",
    description: "Customer reactions",
    status: "active",
    packs: [],
    createdAt: "2026-08-31T00:00:00Z",
    archivedAt: null,
    updatedAt: "2026-08-31T00:00:00Z",
    ...overrides,
  };
}

function binding(overrides = {}) {
  // Binding fixtures retain historical policy because disable output must communicate it.
  return {
    bindingId: `spb_${"b".repeat(32)}`,
    collectionId: COLLECTION_ID,
    activationId: `rpa_${"c".repeat(32)}`,
    packId: "white-sage-just-me",
    packName: "White Sage: Just Me",
    packVersion: "1.1.4",
    status: "enabled",
    historicalAccess: "preserve",
    updatedAt: "2026-08-31T00:00:00Z",
    ...overrides,
  };
}

function runtimeClient(calls) {
  // One deterministic runtime double exercises every read operation without HTTP coupling.
  const sticker = {
    stickerId: "white-sage-just-me-wave",
    packId: "white-sage-just-me",
    label: "Wave",
    emoji: "👋",
    category: "greeting",
    animated: true,
    variants: [{ name: "small_160", bytes: 2048 }],
  };
  return {
    listPacks: async () => [{
      packId: "white-sage-just-me",
      name: "White Sage: Just Me",
      version: "1.1.4",
      assetCount: 40,
      animated: true,
    }],
    search: async (query, options) => {
      calls.push(["search", query, options]);
      return { query, items: [sticker], total: 1 };
    },
    typeahead: async (query, options) => {
      calls.push(["typeahead", query, options]);
      return { query, locale: options.locale ?? "en", suggestions: [{ text: "wave", assetCount: 1 }] };
    },
    retrieve: async (stickerId) => {
      calls.push(["get", stickerId]);
      return sticker;
    },
    resolve: async (stickerId, variant) => {
      calls.push(["resolve", stickerId, variant]);
      return {
        stickerId,
        packId: sticker.packId,
        packVersion: "1.1.4",
        variant,
        bytes: 2048,
        expiresAt: "2026-08-31T00:05:00Z",
        url: "https://storage.example.test/sticker?signature=explicit",
      };
    },
  };
}

function hostedClient(calls) {
  // The fake records calls at the public SDK boundary, which is the CLI's intended contract.
  return {
    listCollections: async (options) => {
      calls.push(["collections.list", options]);
      return { items: [collection()], total: 1 };
    },
    createCollection: async (params) => {
      calls.push(["collections.create", params]);
      return collection({ name: params.name, description: params.description ?? "" });
    },
    getCollection: async (id) => {
      calls.push(["collections.get", id]);
      return collection();
    },
    updateCollection: async (id, params) => {
      calls.push(["collections.update", id, params]);
      return collection({ ...params, description: params.description ?? "" });
    },
    archiveCollection: async (id) => {
      calls.push(["collections.archive", id]);
      return collection({ status: "archived", archivedAt: "2026-08-31T01:00:00Z" });
    },
    listCollectionPacks: async (id) => {
      calls.push(["bindings.list", id]);
      return { items: [binding()], total: 1 };
    },
    addCollectionPack: async (id, params) => {
      calls.push(["bindings.add", id, params]);
      return binding({ activationId: params.activationId });
    },
    enableCollectionPack: async (id, packId) => {
      calls.push(["bindings.enable", id, packId]);
      return binding({ packId });
    },
    disableCollectionPack: async (id, packId) => {
      calls.push(["bindings.disable", id, packId]);
      return binding({ packId, status: "disabled" });
    },
    collection: () => runtimeClient(calls),
    usage: async () => ({
      month: "2026-08",
      status: "healthy",
      operations: 12,
      includedOperations: 10_000,
      authorizedDeliveryBytes: 2048,
      includedDeliveryBytes: 1_000_000,
      overageChargedCents: 0,
      currency: "USD",
    }),
    createClientToken: async (params) => {
      calls.push(["token.create", params]);
      return {
        accessToken: "mrt_v1_secret",
        expiresAt: "2026-08-31T00:15:00Z",
        collectionId: params.collectionId,
        scopes: params.scopes ?? ["packs:read", "stickers:search", "stickers:read", "assets:resolve"],
      };
    },
  };
}

function dependencies(calls, writes) {
  // Central entrypoint tests inject a complete authenticated resource without credential I/O.
  return {
    createClient: () => ({ jobs: {}, capabilities: {}, stickers: hostedClient(calls) }),
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  };
}

test("sticker help exposes the full auth boundary without constructing a client", async () => {
  const writes = { stdout: "", stderr: "" };
  let constructed = false;
  const code = await executeCli(["stickers", "--help"], {
    createClient: () => {
      constructed = true;
      throw new Error("help must remain local");
    },
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  });
  assert.equal(code, 0);
  assert.equal(constructed, false);
  assert.match(writes.stdout, /collections packs enable/);
  assert.match(writes.stdout, /MEDIARUNTIME_STICKER_CLIENT_TOKEN/);
  assert.match(writes.stdout, /required for management/);
});

test("sticker collection commands cover reversible lifecycle management", async () => {
  const calls = [];
  const writes = { stdout: "", stderr: "" };
  const deps = dependencies(calls, writes);
  assert.equal(await executeCli(["stickers", "collections", "list", "--include-archived"], deps), 0);
  assert.match(writes.stdout, /ID\s+NAME\s+STATUS\s+PACKS/);

  writes.stdout = "";
  assert.equal(await executeCli([
    "stickers", "collections", "create", "--name", "Mobile chat", "--description", "Reactions", "--json",
  ], deps), 0);
  assert.equal(JSON.parse(writes.stdout).name, "Mobile chat");

  writes.stdout = "";
  assert.equal(await executeCli([
    "stickers", "collections", "update", COLLECTION_ID,
    "--name", "Support", "--clear-description", "--status", "active",
  ], deps), 0);
  assert.equal(await executeCli(["stickers", "collections", "get", COLLECTION_ID], deps), 0);
  assert.equal(await executeCli(["stickers", "collections", "archive", COLLECTION_ID], deps), 0);

  assert.deepEqual(calls.slice(0, 5), [
    ["collections.list", { includeArchived: true }],
    ["collections.create", { name: "Mobile chat", description: "Reactions" }],
    ["collections.update", COLLECTION_ID, { name: "Support", description: null, status: "active" }],
    ["collections.get", COLLECTION_ID],
    ["collections.archive", COLLECTION_ID],
  ]);
  assert.equal(writes.stderr, "");
});

test("collection pack commands support activation and stable pack identifiers", async () => {
  const calls = [];
  const writes = { stdout: "", stderr: "" };
  const deps = dependencies(calls, writes);
  assert.equal(await executeCli([
    "stickers", "collections", "packs", "list", COLLECTION_ID, "--json",
  ], deps), 0);
  assert.equal(JSON.parse(writes.stdout).total, 1);

  writes.stdout = "";
  assert.equal(await executeCli([
    "stickers", "collections", "packs", "enable", COLLECTION_ID,
    "--activation", `rpa_${"d".repeat(32)}`,
  ], deps), 0);
  assert.equal(await executeCli([
    "stickers", "collections", "packs", "enable", COLLECTION_ID,
    "--pack", "white-sage-just-me",
  ], deps), 0);
  assert.equal(await executeCli([
    "stickers", "collections", "packs", "disable", COLLECTION_ID,
    "--pack", "white-sage-just-me",
  ], deps), 0);
  assert.deepEqual(calls, [
    ["bindings.list", COLLECTION_ID],
    ["bindings.add", COLLECTION_ID, { activationId: `rpa_${"d".repeat(32)}` }],
    ["bindings.enable", COLLECTION_ID, "white-sage-just-me"],
    ["bindings.disable", COLLECTION_ID, "white-sage-just-me"],
  ]);
  assert.match(writes.stdout, /historical references remain preserve/);
});

test("runtime commands forward collection-bound search and resolution options", async () => {
  const calls = [];
  const writes = { stdout: "", stderr: "" };
  const deps = dependencies(calls, writes);
  assert.equal(await executeCli([
    "stickers", "packs", "list", "--collection", COLLECTION_ID,
  ], deps), 0);
  assert.match(writes.stdout, /White Sage: Just Me/);

  writes.stdout = "";
  assert.equal(await executeCli([
    "stickers", "search", "wave", "--collection", COLLECTION_ID,
    "--pack", "white-sage-just-me", "--category", "greeting", "--animated", "--limit", "10", "--json",
  ], deps), 0);
  assert.equal(JSON.parse(writes.stdout).items[0].stickerId, "white-sage-just-me-wave");
  assert.equal(await executeCli([
    "stickers", "typeahead", "wa", "--collection", COLLECTION_ID, "--locale", "ko", "--limit", "5",
  ], deps), 0);
  assert.equal(await executeCli([
    "stickers", "get", "white-sage-just-me-wave", "--collection", COLLECTION_ID,
  ], deps), 0);
  assert.equal(await executeCli([
    "stickers", "resolve", "white-sage-just-me-wave", "--variant", "small_160",
    "--collection", COLLECTION_ID,
  ], deps), 0);
  assert.deepEqual(calls, [
    ["search", "wave", { packId: "white-sage-just-me", category: "greeting", animated: true, limit: 10 }],
    ["typeahead", "wa", { locale: "ko", limit: 5 }],
    ["get", "white-sage-just-me-wave"],
    ["resolve", "white-sage-just-me-wave", "small_160"],
  ]);
  assert.match(writes.stdout, /signature=explicit/);
});

test("usage and token commands remain trusted API-key operations", async () => {
  const calls = [];
  const writes = { stdout: "", stderr: "" };
  const deps = dependencies(calls, writes);
  assert.equal(await executeCli(["stickers", "usage", "--json"], deps), 0);
  assert.equal(JSON.parse(writes.stdout).operations, 12);

  writes.stdout = "";
  assert.equal(await executeCli([
    "stickers", "token", "create", "--collection", COLLECTION_ID,
    "--expires-in", "600", "--scope", "stickers:search", "--scope", "assets:resolve", "--json",
  ], deps), 0);
  assert.equal(JSON.parse(writes.stdout).accessToken, "mrt_v1_secret");
  assert.deepEqual(calls, [["token.create", {
    collectionId: COLLECTION_ID,
    expiresInSeconds: 600,
    scopes: ["stickers:search", "assets:resolve"],
  }]]);
});

test("scoped token bypasses master client construction only for runtime reads", async () => {
  const previous = process.env.MEDIARUNTIME_STICKER_CLIENT_TOKEN;
  process.env.MEDIARUNTIME_STICKER_CLIENT_TOKEN = "mrt_v1_scoped";
  const calls = [];
  const writes = { stdout: "", stderr: "" };
  let masterConstructed = false;
  let receivedOptions;
  const deps = {
    createClient: () => {
      masterConstructed = true;
      throw new Error("master client must not be constructed");
    },
    createStickerRuntime: (options) => {
      receivedOptions = options;
      return runtimeClient(calls);
    },
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  };
  try {
    assert.equal(await executeCli([
      "stickers", "search", "wave", "--collection", COLLECTION_ID, "--json",
    ], deps), 0);
    assert.equal(masterConstructed, false);
    assert.deepEqual(receivedOptions, { accessToken: "mrt_v1_scoped", collectionId: COLLECTION_ID });

    const code = await executeCli(["stickers", "usage", "--json"], deps);
    assert.equal(masterConstructed, true);
    assert.equal(code, 1);
  } finally {
    if (previous === undefined) delete process.env.MEDIARUNTIME_STICKER_CLIENT_TOKEN;
    else process.env.MEDIARUNTIME_STICKER_CLIENT_TOKEN = previous;
  }
});

test("sticker commands reject unsafe or incomplete arguments before SDK calls", async () => {
  const calls = [];
  const writes = { stdout: "", stderr: "" };
  const deps = dependencies(calls, writes);
  assert.equal(await executeCli(["stickers", "search", "wave", "--collection", "../../other", "--json"], deps), 2);
  assert.equal(await executeCli([
    "stickers", "collections", "packs", "enable", COLLECTION_ID,
    "--pack", "one", "--activation", `rpa_${"d".repeat(32)}`, "--json",
  ], deps), 2);
  assert.equal(await executeCli([
    "stickers", "token", "create", "--collection", COLLECTION_ID, "--scope", "admin", "--json",
  ], deps), 2);
  assert.equal(await executeCli([
    "stickers", "resolve", "white-sage-just-me-wave", "--variant", "original",
    "--collection", COLLECTION_ID, "--json",
  ], deps), 2);
  assert.equal(await executeCli([
    "stickers", "get", "white-sage-just-me-wave", "--limit", "10",
    "--collection", COLLECTION_ID, "--json",
  ], deps), 2);
  assert.deepEqual(calls, []);
  assert.match(writes.stderr, /MediaRuntime sticker collection ID/);
});
