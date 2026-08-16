import type { JobDetails, JobPage, JobStatus, ListJobsParams } from "@mediaruntime/node";
import { BundleDownloadError, UsageError } from "../errors.js";

const UNSUCCESSFUL_TERMINAL_STATUSES = new Set(["FAILED", "REJECTED", "PARTIAL"]);

export interface JobsReadClient {
  list(params?: ListJobsParams): Promise<JobPage>;
  get(jobId: string): Promise<JobDetails>;
}

export interface JobsCommandDependencies {
  jobs: JobsReadClient;
  writeStdout(text: string): void;
  downloadBundle(
    url: string,
    destination: string,
    options: { force: boolean; expectedSizeBytes?: number | null; expectedSha256?: string | null },
  ): Promise<void>;
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
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

function humanDetails(job: JobDetails): string {
  const lines = [
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Tier: ${job.tier.billed ?? job.tier.effective ?? job.tier.requested ?? "-"}`,
    `Bundle: ${job.bundle.available ? "available" : "unavailable"}`,
  ];
  if (job.bundle.sizeBytes !== null) lines.push(`Bundle size: ${job.bundle.sizeBytes} bytes`);
  if (job.error) lines.push(`Error: ${job.error}`);
  return `${lines.join("\n")}\n`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function humanList(page: JobPage): string {
  const rows = page.jobs.map((job) => [
    job.id,
    job.status,
    cell(job.tierBilled),
    cell(job.unitsTotal),
    job.bundleAvailable ? "yes" : "no",
    cell(job.updatedAt),
  ]);
  const headings = ["ID", "STATUS", "TIER", "UNITS", "BUNDLE", "UPDATED"];
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (row: string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd();
  const lines = [render(headings), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)];
  if (page.nextCursor) lines.push(`Next cursor: ${page.nextCursor}`);
  return `${lines.join("\n")}\n`;
}

async function listCommand(args: string[], dependencies: JobsCommandDependencies): Promise<number> {
  let status: string | undefined;
  let limit: number | undefined;
  let cursor: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--status") {
      status = optionValue(args, index, argument).toUpperCase();
      index += 1;
    } else if (argument === "--limit") {
      const value = Number(optionValue(args, index, argument));
      if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
        throw new UsageError("--limit must be an integer between 1 and 100");
      }
      limit = value;
      index += 1;
    } else if (argument === "--cursor") {
      cursor = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else {
      throw new UsageError(`Unknown jobs list option: ${argument}`);
    }
  }
  const params: ListJobsParams = {
    ...(status === undefined ? {} : { status: status as JobStatus }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  const page = await dependencies.jobs.list(params);
  dependencies.writeStdout(json ? `${JSON.stringify(page)}\n` : humanList(page));
  return 0;
}

async function getCommand(args: string[], dependencies: JobsCommandDependencies): Promise<number> {
  let jobId: string | undefined;
  let download: string | undefined;
  let force = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--download") {
      download = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--force") {
      force = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument?.startsWith("-")) {
      throw new UsageError(`Unknown jobs get option: ${argument}`);
    } else if (!jobId) {
      jobId = argument;
    } else {
      throw new UsageError("jobs get accepts exactly one job ID");
    }
  }
  if (!jobId) throw new UsageError("Usage: mediaruntime jobs get <job_id>");
  if (force && !download) throw new UsageError("--force requires --download");
  const job = await dependencies.jobs.get(jobId);
  if (!json) dependencies.writeStdout(humanDetails(job));

  if (UNSUCCESSFUL_TERMINAL_STATUSES.has(String(job.status).toUpperCase())) {
    if (json) dependencies.writeStdout(`${JSON.stringify(detailsProjection(job))}\n`);
    return 6;
  }
  if (download) {
    if (String(job.status).toUpperCase() !== "COMPLETED" ||
        !job.bundle.available || !job.bundle.downloadUrl) {
      throw new BundleDownloadError("Bundle download requires a COMPLETED job with an available canonical bundle");
    }
    try {
      await dependencies.downloadBundle(job.bundle.downloadUrl, download, {
        force,
        expectedSizeBytes: job.bundle.sizeBytes,
        expectedSha256: job.bundle.sha256,
      });
    } catch (error) {
      if (error instanceof BundleDownloadError) throw error;
      throw new BundleDownloadError(`Could not download bundle to ${download}`, { cause: error });
    }
    if (!json) dependencies.writeStdout(`Downloaded bundle to ${download}\n`);
  }
  if (json) dependencies.writeStdout(`${JSON.stringify(detailsProjection(job))}\n`);
  return 0;
}

export async function runJobsCommand(
  args: string[],
  dependencies: JobsCommandDependencies,
): Promise<number> {
  const subcommand = args[0];
  if (subcommand === "list") return listCommand(args.slice(1), dependencies);
  if (subcommand === "get") return getCommand(args.slice(1), dependencies);
  throw new UsageError("Usage: mediaruntime jobs <list|get>");
}
