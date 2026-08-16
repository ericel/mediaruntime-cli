import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { parseLocalDestination } from "../trigger/destination.js";
import {
  SUPPORTED_TRIGGER_EVENTS,
  createSyntheticTerminalEvent,
  isTriggerEventType,
  type TriggerEventType,
} from "../trigger/event.js";
import { signSyntheticWebhook } from "../trigger/signature.js";
import { TriggerDeliveryError, UsageError } from "../errors.js";

export interface TriggerCommandDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  randomUUID?: () => string;
  randomBytes?: (size: number) => Uint8Array;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  writeStdout?: (text: string) => void;
}

interface TriggerArguments {
  type: TriggerEventType;
  destination: URL;
  secretFile?: string;
  generateSecret: boolean;
  jobId?: string;
  accountId?: string;
  json: boolean;
}

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
}

export function parseTriggerArguments(args: string[]): TriggerArguments {
  const typeValue = args[0];
  if (!typeValue || typeValue.startsWith("--")) {
    throw new UsageError(
      `trigger requires an event type: ${SUPPORTED_TRIGGER_EVENTS.join(", ")}`,
    );
  }
  if (!isTriggerEventType(typeValue)) {
    throw new UsageError(
      `Unsupported trigger event ${JSON.stringify(typeValue)}; expected ${SUPPORTED_TRIGGER_EVENTS.join(", ")}`,
    );
  }

  let to: string | undefined;
  let secretFile: string | undefined;
  let generateSecret = false;
  let jobId: string | undefined;
  let accountId: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (!option) continue;
    if (option === "--generate-secret") {
      generateSecret = true;
      continue;
    }
    if (option === "--json") {
      json = true;
      continue;
    }
    if (["--to", "--secret-file", "--job-id", "--account-id"].includes(option)) {
      const value = requireOptionValue(args, index, option);
      index += 1;
      if (option === "--to") to = value;
      else if (option === "--secret-file") secretFile = value;
      else if (option === "--job-id") jobId = value;
      else accountId = value;
      continue;
    }
    throw new UsageError(`Unknown trigger option: ${option}`);
  }

  if (!to) throw new UsageError("trigger requires an explicit --to local URL");
  if (generateSecret && secretFile) {
    throw new UsageError("--generate-secret and --secret-file are mutually exclusive");
  }
  if (generateSecret && json) {
    throw new UsageError("--generate-secret and --json are mutually exclusive");
  }
  if (jobId !== undefined && !jobId.trim()) throw new UsageError("--job-id must not be empty");
  if (accountId !== undefined && !accountId.trim()) {
    throw new UsageError("--account-id must not be empty");
  }
  return {
    type: typeValue,
    destination: parseLocalDestination(to),
    ...(secretFile === undefined ? {} : { secretFile }),
    generateSecret,
    ...(jobId === undefined ? {} : { jobId: jobId.trim() }),
    ...(accountId === undefined ? {} : { accountId: accountId.trim() }),
    json,
  };
}

async function resolveSecret(
  args: TriggerArguments,
  dependencies: Required<
    Pick<TriggerCommandDependencies, "env" | "randomBytes" | "readFile" | "writeStdout">
  >,
): Promise<string> {
  if (args.generateSecret) {
    const generated = Buffer.from(dependencies.randomBytes(32)).toString("base64url");
    dependencies.writeStdout(
      `Generated webhook secret (configure the local receiver with this value): ${generated}\n`,
    );
    return generated;
  }
  let secret: string | undefined;
  if (args.secretFile) {
    try {
      secret = await dependencies.readFile(args.secretFile, "utf8");
    } catch (error) {
      throw new UsageError(`Could not read webhook secret file: ${args.secretFile}`, { cause: error });
    }
  } else {
    secret = dependencies.env.MEDIARUNTIME_WEBHOOK_SECRET;
  }
  const normalized = secret?.trim();
  if (!normalized) {
    throw new UsageError(
      "Set MEDIARUNTIME_WEBHOOK_SECRET, pass --secret-file, or explicitly use --generate-secret",
    );
  }
  return normalized;
}

export async function runTriggerCommand(
  args: string[],
  dependencies: TriggerCommandDependencies = {},
): Promise<number> {
  const parsed = parseTriggerArguments(args);
  const deps = {
    env: dependencies.env ?? process.env,
    fetch: dependencies.fetch ?? globalThis.fetch,
    now: dependencies.now ?? Date.now,
    randomUUID: dependencies.randomUUID ?? randomUUID,
    randomBytes: dependencies.randomBytes ?? randomBytes,
    readFile: dependencies.readFile ?? readFile,
    writeStdout: dependencies.writeStdout ?? ((text: string) => process.stdout.write(text)),
  };
  const secret = await resolveSecret(parsed, deps);
  const timestamp = Math.floor(deps.now() / 1000);
  const unique = deps.randomUUID();
  const eventId = `evt_cli_${unique}`;
  const jobId = parsed.jobId ?? `job_cli_${unique}`;
  const accountId = parsed.accountId ?? "acc_cli_local";
  const payload = createSyntheticTerminalEvent(parsed.type, {
    eventId,
    jobId,
    accountId,
    timestamp,
  });
  const signed = signSyntheticWebhook(payload, { eventId, timestamp, secret });

  const response = await deps.fetch(parsed.destination, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new TriggerDeliveryError(
      `Local webhook endpoint returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );
  }
  if (parsed.json) {
    deps.writeStdout(`${JSON.stringify({
      eventId,
      type: parsed.type,
      jobId,
      status: payload.status,
      destination: parsed.destination.href,
      httpStatus: response.status,
    })}\n`);
  } else {
    deps.writeStdout(
      `Sent synthetic ${parsed.type} event ${eventId} to ${parsed.destination.href} (HTTP ${response.status})\n`,
    );
  }
  return 0;
}
