import { appendFile } from "node:fs/promises";
import process from "node:process";

const packageMetadata = await import("../package.json", { with: { type: "json" } });
const version = packageMetadata.default.version;
const tag = process.env.GITHUB_REF_NAME ?? "";
if (tag !== `v${version}`) {
  throw new Error(`Release tag ${JSON.stringify(tag)} must match package version v${version}`);
}
const distTag = version.includes("-") ? "next" : "latest";
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `dist-tag=${distTag}\n`);
}
console.log(`Publishing ${version} with npm dist-tag ${distTag}`);
