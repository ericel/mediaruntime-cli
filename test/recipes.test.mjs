import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeCli } from "../dist/cli.js";

function hosted(version = 1) {
  return {
    name: "team-video",
    version,
    reference: `team-video@${version}`,
    description: "Team default",
    builtIn: false,
    status: "active",
    sha256: "a".repeat(64),
    template: { outputs: ["video.web"] },
  };
}

function dependencies(recipes, writes) {
  return {
    createClient: () => ({
      jobs: {},
      capabilities: {},
      recipes,
    }),
    writeStdout: (text) => { writes.stdout += text; },
    writeStderr: (text) => { writes.stderr += text; },
  };
}

test("recipes list and get render stable human and JSON views", async () => {
  const writes = { stdout: "", stderr: "" };
  const recipes = {
    list: async () => [hosted()],
    get: async (_name, options) => hosted(options.version),
  };
  assert.equal(await executeCli(["recipes", "list"], dependencies(recipes, writes)), 0);
  assert.match(writes.stdout, /REFERENCE\s+TYPE\s+DESCRIPTION/);
  assert.match(writes.stdout, /team-video@1\s+custom\s+Team default/);

  writes.stdout = "";
  assert.equal(await executeCli(
    ["recipes", "get", "team-video", "--version", "2", "--json"],
    dependencies(recipes, writes),
  ), 0);
  assert.equal(JSON.parse(writes.stdout).reference, "team-video@2");
});

test("recipes create, version, and archive read explicit JSON files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediaruntime-recipes-"));
  const file = join(directory, "recipe.json");
  await writeFile(file, JSON.stringify({
    name: "team-video",
    description: "Team default",
    template: { outputs: ["video.web"] },
  }));
  const calls = [];
  const recipes = {
    create: async (value) => { calls.push(["create", value]); return hosted(); },
    createVersion: async (name, value) => { calls.push(["version", name, value]); return hosted(2); },
    archive: async (name) => { calls.push(["archive", name]); },
  };
  const writes = { stdout: "", stderr: "" };
  try {
    assert.equal(await executeCli(
      ["recipes", "create", "--file", file],
      dependencies(recipes, writes),
    ), 0);
    assert.equal(await executeCli(
      ["recipes", "version", "team-video", "--file", file, "--expected", "1"],
      dependencies(recipes, writes),
    ), 0);
    assert.equal(await executeCli(
      ["recipes", "archive", "team-video", "--json"],
      dependencies(recipes, writes),
    ), 0);
    assert.deepEqual(calls[0], ["create", {
      name: "team-video",
      description: "Team default",
      template: { outputs: ["video.web"] },
    }]);
    assert.deepEqual(calls[1], ["version", "team-video", {
      expectedLatestVersion: 1,
      description: "Team default",
      template: { outputs: ["video.web"] },
    }]);
    assert.deepEqual(calls[2], ["archive", "team-video"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
