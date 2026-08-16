import type {
  CreateJobParams,
  JobDetails,
  JobOutput,
  JobReceiptData,
  Metadata,
  OutputAlias,
  WaitForJobOptions,
} from "@mediaruntime/node";
import { BundleDownloadError, UsageError } from "../errors.js";

const UNSUCCESSFUL_TERMINAL_STATUSES = new Set(["FAILED", "REJECTED", "PARTIAL"]);
const OUTPUT_ALIASES = new Set([
  "video.web",
  "video.streaming",
  "video.social",
  "audio.web",
  "audio.transcription",
  "image.web",
]);

interface SubmittedJob extends JobReceiptData {
  wait(options?: WaitForJobOptions): Promise<JobDetails>;
}

export interface RunJobsClient {
  create(params: CreateJobParams): Promise<SubmittedJob>;
}

export interface RunCommandDependencies {
  jobs: RunJobsClient;
  writeStdout(text: string): void;
  downloadBundle(
    url: string,
    destination: string,
    options: { force: boolean; expectedSizeBytes?: number | null; expectedSha256?: string | null },
  ): Promise<void>;
}

interface RunOptions {
  source: string;
  outputs: string[];
  metadata?: Metadata;
  idempotencyKey?: string;
  wait: boolean;
  timeoutMs?: number;
  download?: string;
  force: boolean;
  json: boolean;
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
}

function parseMetadata(value: string): Metadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new UsageError("--metadata must be a valid JSON object");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--metadata must be a JSON object");
  }
  return parsed as Metadata;
}

function parseRunOptions(args: string[]): RunOptions {
  let source: string | undefined;
  const outputs: string[] = [];
  let metadata: Metadata | undefined;
  let idempotencyKey: string | undefined;
  let wait = false;
  let timeoutMs: number | undefined;
  let download: string | undefined;
  let force = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output" || argument === "-o") {
      outputs.push(optionValue(args, index, argument));
      index += 1;
    } else if (argument === "--metadata") {
      metadata = parseMetadata(optionValue(args, index, argument));
      index += 1;
    } else if (argument === "--idempotency-key") {
      idempotencyKey = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--wait") {
      wait = true;
    } else if (argument === "--timeout-ms") {
      const value = Number(optionValue(args, index, argument));
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new UsageError("--timeout-ms must be a positive integer");
      }
      timeoutMs = value;
      index += 1;
    } else if (argument === "--download") {
      download = optionValue(args, index, argument);
      wait = true;
      index += 1;
    } else if (argument === "--force") {
      force = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument?.startsWith("-")) {
      throw new UsageError(`Unknown run option: ${argument}`);
    } else if (source === undefined) {
      source = argument;
    } else {
      throw new UsageError("run accepts exactly one source");
    }
  }

  if (!source) throw new UsageError("Usage: mediaruntime run <source> --output <alias> [--wait]");
  if (outputs.length === 0) throw new UsageError("run requires at least one --output");
  const unsupported = outputs.find((output) => !OUTPUT_ALIASES.has(output));
  if (unsupported) throw new UsageError(`Unsupported output alias: ${unsupported}`);
  if (force && !download) throw new UsageError("--force requires --download");
  if (timeoutMs !== undefined && !wait) throw new UsageError("--timeout-ms requires --wait or --download");
  return {
    source,
    outputs,
    ...(metadata === undefined ? {} : { metadata }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    wait,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(download === undefined ? {} : { download }),
    force,
    json,
  };
}

function receiptProjection(job: SubmittedJob): JobReceiptData {
  return {
    id: job.id,
    status: job.status,
    tier: job.tier,
    requiredTier: job.requiredTier,
    outputs: job.outputs,
    message: job.message,
  };
}

function detailsProjection(job: JobDetails): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    tier: job.tier,
    usage: job.usage,
    billing: job.billing,
    bundle: {
      available: job.bundle.available,
      expiresAt: job.bundle.expiresAt,
      sizeBytes: job.bundle.sizeBytes,
      sha256: job.bundle.sha256,
      retentionDays: job.bundle.retentionDays,
    },
    media: job.media,
    metadata: job.metadata,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

function writeHumanReceipt(job: SubmittedJob, write: (text: string) => void): void {
  write(`Job: ${job.id}\nStatus: ${job.status}\nTier: ${job.tier || "-"}\n`);
}

function writeHumanDetails(job: JobDetails, write: (text: string) => void): void {
  const error = job.error ? `\nError: ${job.error}` : "";
  write(
    `Job: ${job.id}\nStatus: ${job.status}\n` +
      `Bundle: ${job.bundle.available ? "available" : "unavailable"}${error}\n`,
  );
}

export async function runCommand(
  args: string[],
  dependencies: RunCommandDependencies,
): Promise<number> {
  const options = parseRunOptions(args);
  const params: CreateJobParams = {
    source: options.source,
    outputs: options.outputs as Array<OutputAlias | JobOutput>,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  };
  const submitted = await dependencies.jobs.create(params);

  if (!options.wait) {
    if (options.json) dependencies.writeStdout(`${JSON.stringify(receiptProjection(submitted))}\n`);
    else writeHumanReceipt(submitted, dependencies.writeStdout);
    return UNSUCCESSFUL_TERMINAL_STATUSES.has(String(submitted.status).toUpperCase()) ? 6 : 0;
  }

  const details = await submitted.wait(
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  if (!options.json) writeHumanDetails(details, dependencies.writeStdout);
  if (String(details.status).toUpperCase() !== "COMPLETED") {
    if (options.json) dependencies.writeStdout(`${JSON.stringify(detailsProjection(details))}\n`);
    return 6;
  }
  if (options.download) {
    const url = details.bundle.downloadUrl;
    if (!details.bundle.available || !url) {
      throw new BundleDownloadError("Completed job does not have an available canonical bundle");
    }
    try {
      await dependencies.downloadBundle(url, options.download, {
        force: options.force,
        expectedSizeBytes: details.bundle.sizeBytes,
        expectedSha256: details.bundle.sha256,
      });
    } catch (error) {
      if (error instanceof BundleDownloadError) throw error;
      throw new BundleDownloadError(`Could not download bundle to ${options.download}`, { cause: error });
    }
    if (!options.json) dependencies.writeStdout(`Downloaded bundle to ${options.download}\n`);
  }
  if (options.json) dependencies.writeStdout(`${JSON.stringify(detailsProjection(details))}\n`);
  return 0;
}
