import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("release metadata accepts the matching stable tag", () => {
  const result = spawnSync(process.execPath, ["scripts/release-metadata.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_REF_NAME: "v1.1.0" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dist-tag latest/);
});

test("release metadata rejects a mismatched tag", () => {
  const result = spawnSync(process.execPath, ["scripts/release-metadata.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_REF_NAME: "v9.9.9" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must match package version/);
});
