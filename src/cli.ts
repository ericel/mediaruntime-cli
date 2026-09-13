import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  access,
  link,
  rename,
  rm,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import {
  JobWaitTimeoutError,
  MediaRuntime,
  MediaRuntimeApiError,
  MediaRuntimeConnectionError,
} from "@mediaruntime/node";
import * as MediaRuntimeSdk from "@mediaruntime/node";
import { PRODUCTION_ORIGIN } from "./auth/api.js";
import type { CredentialStore } from "./auth/credential-store.js";
import {
  resolveCredential,
  runAuthCommand,
  runLoginCommand,
  runLogoutCommand,
  type AuthCommandDependencies,
} from "./commands/auth.js";
import {
  runCapabilitiesCommand,
  runPresetsCommand,
  type CapabilitiesReadClient,
} from "./commands/capabilities.js";
import {
  runJobsCommand,
  type JobsReadClient,
} from "./commands/jobs.js";
import {
  runCommand,
  type RunJobsClient,
} from "./commands/run.js";
import { runRecipesCommand, type RecipesClient } from "./commands/recipes.js";
import {
  isScopedStickerRuntimeCommand,
  runStickersCommand,
  stickerCollectionOption,
  type HostedStickersCommandClient,
  type StickerRuntimeReadClient,
} from "./commands/stickers.js";
import { runTriggerCommand } from "./commands/trigger.js";
import { BundleDownloadError, CliError, UsageError } from "./errors.js";
import { isLoopbackDestination } from "./trigger/destination.js";
import { createActivityIndicator } from "./ui/activity.js";

export { parseTriggerArguments, runTriggerCommand } from "./commands/trigger.js";
export { createSyntheticTerminalEvent } from "./trigger/event.js";
export { signSyntheticWebhook } from "./trigger/signature.js";
export {
  resolveCredential,
  runAuthCommand,
  runAuthStatusCommand,
  runLoginCommand,
  runLogoutCommand,
} from "./commands/auth.js";

const VERSION = "1.4.0";
const HELP = `MediaRuntime CLI

Usage:
  mediaruntime run <source> (--recipe <name[@version]> | --output <alias> | --preset <name>) [...] [--wait]
    Animation presets: [--animation-width N] [--animation-fps N] [--animation-start SEC]
      [--animation-duration SEC] [--animation-loop N] [--animation-quality N]
    Placeholder preset: [--placeholder-max-dimension N] [--placeholder-time SEC]
      [--lqip-quality N] [--lqip-max-bytes N]
    Contact-sheet preset: [--contact-columns N] [--contact-rows N]
      [--contact-tile-width N] [--contact-tile-height N] [--contact-interval SEC]
      [--contact-start SEC] [--contact-duration SEC] [--contact-max-sheets N]
      [--contact-format jpg|png|webp] [--contact-quality N]
      [--image-width PX] [--image-height PX] [--image-mode fit|fill|cover|contain]
      [--image-format jpg|png|webp|avif] [--image-quality N]
      [--image-max-bytes N] [--image-min-quality N]
    Clip render: --preset video_clip_v1 --clip-start SEC --clip-duration SEC
      [--clip-layout original|vertical_blur] [--clip-transcript <plan.json|captions.srt|captions.vtt>] [--clip-captions]
    Clip suggestions: --preset clip_candidates_v1 [--clip-min-duration SEC]
      [--clip-max-duration SEC] [--clip-count 1..20] [--clip-keyword TEXT]
      [--clip-transcript <plan.json|captions.srt|captions.vtt>]
    Audiogram preset: --audiogram-artwork <source> [--audiogram-captions <source>]
      [--audiogram-layout square|portrait|landscape]
      [--audiogram-fit contain|cover|blurred_background]
      [--audiogram-background #RRGGBB] [--audiogram-waveform #RRGGBB]
      [--audiogram-waveform-gain 0.5..4]
      [--audiogram-caption-position top|bottom] [--audiogram-caption-scale 0.75..1.5]
      [--audiogram-normalize] [--audiogram-loudness-target -24..-12]
      [--audiogram-start SEC] [--audiogram-duration SEC] [--audiogram-fps 15..30]
    Privacy redaction Preview (still-image input + image output only):
      --privacy-detector face|license_plate|text
      [--privacy-style blur|pixelate|solid] [--privacy-failure-mode fail_closed|report_only]
      [--privacy-min-confidence 0.30..0.99] [--privacy-sample-interval 0.1..30]
      [--privacy-max-frames 1..18000] [--privacy-padding 0..0.5]
      [--privacy-solid-color #RRGGBB] [--privacy-pixel-block-size 4..128]
      [--privacy-strength standard|strong] [--privacy-debug-observations]
  mediaruntime capabilities [--json]
  mediaruntime presets list [--json]
  mediaruntime jobs list [--status <status>] [--limit <n>] [--cursor <cursor>]
  mediaruntime jobs get <job_id> [--download <bundle.zip>] [--force]
  mediaruntime recipes <list|get|create|version|archive>
  mediaruntime stickers collections <list|create|get|update|archive|packs>
  mediaruntime stickers packs list --collection <collection_id>
  mediaruntime stickers search <query> --collection <collection_id>
  mediaruntime stickers typeahead <prefix> --collection <collection_id>
  mediaruntime stickers get <sticker_id> --collection <collection_id>
  mediaruntime stickers resolve <sticker_id> --variant <name> --collection <collection_id>
  mediaruntime stickers usage
  mediaruntime stickers token create --collection <collection_id>
  mediaruntime trigger <job.completed|job.failed|job.rejected> --to <local-url>
  mediaruntime login [--no-browser]
  mediaruntime auth status
  mediaruntime logout [--local-only]

Global options:
  --base-url <url>  Developer override; normally leave unset
  --help            Show help
  --version         Show version

Run/jobs options:
  --json            Machine-readable, URL-redacted output

Authentication uses a secure login or MEDIARUNTIME_API_KEY.
Sticker commands use that API key by default. MEDIARUNTIME_STICKER_CLIENT_TOKEN may
replace it only for collection-bound packs/search/typeahead/get/resolve reads; it cannot
manage collections, inspect workspace usage, or mint another token.
`;

type CliJobsClient = RunJobsClient & JobsReadClient;

export interface CliClient {
  jobs: CliJobsClient;
  capabilities: CapabilitiesReadClient;
  uploads?: {
    resolveSource(source: string): Promise<string>;
  };
  recipes?: RecipesClient;
  stickers?: HostedStickersCommandClient;
}

export interface CliDependencies {
  createClient?(options: { baseUrl?: string; apiKey?: string }): CliClient;
  createStickerRuntime?(options: {
    accessToken: string;
    collectionId: string;
    baseUrl?: string;
  }): StickerRuntimeReadClient;
  downloadBundle?(
    url: string,
    destination: string,
    options: {
      force: boolean;
      expectedSizeBytes?: number | null;
      expectedSha256?: string | null;
    },
  ): Promise<void>;
  writeStdout?(text: string): void;
  writeStderr?(text: string): void;
  isStderrTTY?: boolean;
  credentialStore?: CredentialStore;
  openBrowser?(url: string): Promise<void>;
  sleep?(milliseconds: number): Promise<void>;
  now?(): number;
  randomVerifier?(): string;
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function downloadBundleAtomically(
  url: string,
  destination: string,
  options: {
    force: boolean;
    expectedSizeBytes?: number | null;
    expectedSha256?: string | null;
  },
): Promise<void> {
  // Stream into a private sibling file so an interrupted transfer never appears complete.
  const target = resolve(destination);
  if (!options.force && await exists(target)) {
    throw new BundleDownloadError(`Refusing to overwrite existing file: ${destination}`);
  }
  const temporary = resolve(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.part`,
  );

  try {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new BundleDownloadError("Bundle download failed before receiving a response", { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BundleDownloadError(`Bundle download failed with HTTP ${response.status}`);
    }
    if (!response.body) throw new BundleDownloadError("Bundle download returned an empty response body");
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const integrity = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      integrity,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const sha256 = hash.digest("hex");
    // Validate before the temporary file becomes visible at the requested destination.
    if (options.expectedSizeBytes !== undefined && options.expectedSizeBytes !== null &&
        sizeBytes !== options.expectedSizeBytes) {
      throw new BundleDownloadError(
        `Bundle size mismatch: expected ${options.expectedSizeBytes} bytes, received ${sizeBytes}`,
      );
    }
    if (options.expectedSha256 && sha256 !== options.expectedSha256.toLowerCase()) {
      throw new BundleDownloadError("Bundle SHA-256 mismatch");
    }

    if (options.force) {
      await rename(temporary, target);
    } else {
      try {
        // A hard link publishes the completed same-filesystem temporary file atomically
        // and fails rather than replacing a destination created during the download.
        await link(temporary, target);
      } catch (error) {
        if (isFileExistsError(error)) {
          throw new BundleDownloadError(`Refusing to overwrite existing file: ${destination}`);
        }
        throw error;
      }
      await rm(temporary);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof BundleDownloadError) throw error;
    throw new BundleDownloadError(`Could not write bundle to ${destination}`, { cause: error });
  }
}

function normalizeBaseUrl(raw: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new UsageError("--base-url must be an absolute HTTP(S) origin");
  }
  if (value.username || value.password || value.search || value.hash || value.pathname !== "/") {
    throw new UsageError("--base-url must be an origin without credentials, path, query, or fragment");
  }
  // Plain HTTP is acceptable only for a developer-controlled loopback gateway.
  if (value.protocol !== "https:" && !(value.protocol === "http:" && isLoopbackDestination(value))) {
    throw new UsageError("--base-url must use HTTPS unless it points to loopback");
  }
  return value.origin;
}

function extractGlobalOptions(argv: string[]): { baseUrl?: string; args: string[] } {
  const args = [...argv];
  let baseUrl: string | undefined;
  while (args[0] === "--base-url") {
    const value = args[1];
    if (!value || value.startsWith("--")) throw new UsageError("--base-url requires a value");
    baseUrl = normalizeBaseUrl(value);
    args.splice(0, 2);
  }
  return { ...(baseUrl === undefined ? {} : { baseUrl }), args };
}

function safeApiError(error: MediaRuntimeApiError): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    retryable: error.retryable,
    requestId: error.requestId ?? null,
    field: error.field ?? null,
  };
}

function exitCodeFor(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof JobWaitTimeoutError) return 7;
  if (error instanceof MediaRuntimeConnectionError) return 5;
  if (error instanceof MediaRuntimeApiError) {
    if ([401, 402, 403].includes(error.status)) return 3;
    if (error.status >= 500) return 5;
    return 4;
  }
  if (error instanceof DOMException && error.name === "AbortError") return 130;
  if (error instanceof TypeError && /fetch|network|socket|connect/i.test(error.message)) return 5;
  return 1;
}

function safeError(error: unknown, exitCode: number): Record<string, unknown> {
  if (error instanceof MediaRuntimeApiError) return { ...safeApiError(error), exitCode };
  return {
    code: error instanceof CliError ? error.code : "cli_error",
    message: error instanceof Error ? error.message : "Unknown error",
    exitCode,
  };
}

export async function executeCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  const json = argv.includes("--json");
  const isStderrTTY = dependencies.isStderrTTY ??
    (dependencies.writeStderr === undefined && process.stderr.isTTY === true);
  try {
    const global = extractGlobalOptions(argv);
    const command = global.args[0];
    if (!command || command === "--help" || command === "-h") {
      writeStdout(HELP);
      return 0;
    }
    if (command === "--version" || command === "-v") {
      writeStdout(`${VERSION}\n`);
      return 0;
    }
    if (command === "trigger") {
      return await runTriggerCommand(global.args.slice(1), { writeStdout });
    }

    const configuredBaseUrl = global.baseUrl ?? process.env.MEDIARUNTIME_API_URL;
    const baseUrl = configuredBaseUrl ? normalizeBaseUrl(configuredBaseUrl) : undefined;
    const authBaseUrl = baseUrl ?? PRODUCTION_ORIGIN;
    const authDependencies: AuthCommandDependencies = {
      ...(dependencies.credentialStore ? { credentialStore: dependencies.credentialStore } : {}),
      ...(dependencies.openBrowser ? { openBrowser: dependencies.openBrowser } : {}),
      ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.randomVerifier ? { randomVerifier: dependencies.randomVerifier } : {}),
      writeStdout,
    };
    if (command === "login") return await runLoginCommand(global.args.slice(1), authBaseUrl, authDependencies);
    if (command === "auth") return await runAuthCommand(global.args.slice(1), authBaseUrl, authDependencies);
    if (command === "logout") return await runLogoutCommand(global.args.slice(1), authBaseUrl, authDependencies);

    if (command === "capabilities" || command === "presets") {
      // Discovery is public, so these commands work before login and in setup scripts.
      const publicClient = dependencies.createClient?.({
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }) ?? new MediaRuntime({
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
      const publicDependencies = { capabilities: publicClient.capabilities, writeStdout };
      if (command === "capabilities") {
        return await runCapabilitiesCommand(global.args.slice(1), publicDependencies);
      }
      return await runPresetsCommand(global.args.slice(1), publicDependencies);
    }

    const stickerArguments = global.args.slice(1);
    const stickerClientToken = process.env.MEDIARUNTIME_STICKER_CLIENT_TOKEN?.trim();
    if (command === "stickers" &&
        (!stickerArguments[0] || stickerArguments.includes("--help") || stickerArguments.includes("-h"))) {
      // Help is local and must remain available before login, including on clean machines.
      return await runStickersCommand(stickerArguments, { writeStdout });
    }
    if (command === "stickers" && stickerClientToken && isScopedStickerRuntimeCommand(stickerArguments)) {
      // Scoped mode is dispatched before master-key resolution so an untrusted client
      // credential can never silently fall back to a more privileged stored login.
      const selectedCollectionId = stickerCollectionOption(stickerArguments);
      const options = {
        accessToken: stickerClientToken,
        collectionId: selectedCollectionId,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      };
      const constructor = (MediaRuntimeSdk as unknown as {
        StickerRuntime?: new (value: typeof options) => StickerRuntimeReadClient;
      }).StickerRuntime;
      const runtime = dependencies.createStickerRuntime?.(options) ??
        (constructor ? new constructor(options) : undefined);
      if (!runtime) {
        throw new UsageError("The installed @mediaruntime/node SDK does not support scoped Sticker Runtime tokens");
      }
      return await runStickersCommand(stickerArguments, {
        runtime: () => runtime,
        writeStdout,
      });
    }

    // Preserve the documented precedence: explicit environment key, then browser login.
    let apiKey = process.env.MEDIARUNTIME_API_KEY?.trim();
    if (!apiKey && (!dependencies.createClient || dependencies.credentialStore)) {
      apiKey = (await resolveCredential(authBaseUrl, authDependencies))?.apiKey;
    }
    if (!dependencies.createClient && !apiKey) {
      throw new UsageError("Run mediaruntime login or set MEDIARUNTIME_API_KEY before using this command");
    }
    const client = dependencies.createClient?.({
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(apiKey === undefined ? {} : { apiKey }),
    }) ?? new MediaRuntime({
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    const downloadBundle = dependencies.downloadBundle ?? downloadBundleAtomically;
    const commandDependencies = {
      jobs: client.jobs,
      capabilities: client.capabilities,
      ...(client.uploads ? { uploads: client.uploads } : {}),
      writeStdout,
      downloadBundle,
      activity: createActivityIndicator(writeStderr, isStderrTTY && !json),
    };
    if (command === "run") return await runCommand(global.args.slice(1), commandDependencies);
    if (command === "jobs") {
      return await runJobsCommand(global.args.slice(1), commandDependencies);
    }
    if (command === "recipes") {
      if (!client.recipes) throw new UsageError("This MediaRuntime client does not support hosted recipes");
      return await runRecipesCommand(global.args.slice(1), {
        recipes: client.recipes,
        writeStdout,
      });
    }
    if (command === "stickers") {
      // The structural cast keeps local builds compatible while the additive SDK
      // release carrying the stickers resource moves through package publication.
      const stickers = (client as unknown as CliClient).stickers;
      if (!stickers) throw new UsageError("This MediaRuntime client does not support Hosted Sticker Runtime");
      return await runStickersCommand(stickerArguments, {
        hosted: stickers,
        writeStdout,
      });
    }
    throw new UsageError(`Unknown command: ${command}`);
  } catch (error) {
    const exitCode = exitCodeFor(error);
    if (json) {
      writeStderr(`${JSON.stringify({ error: safeError(error, exitCode) })}\n`);
    } else {
      const requestId = error instanceof MediaRuntimeApiError && error.requestId
        ? ` (request ${error.requestId})`
        : "";
      writeStderr(`Error: ${error instanceof Error ? error.message : "Unknown error"}${requestId}\n`);
    }
    return exitCode;
  }
}

let isEntrypoint = false;
if (process.argv[1] !== undefined) {
  try {
    // npm exposes binaries through a symlink. Resolve both sides so the installed command
    // executes while importing dist/cli.js in tests remains side-effect free.
    isEntrypoint = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isEntrypoint = false;
  }
}
if (isEntrypoint) process.exitCode = await executeCli(process.argv.slice(2));
