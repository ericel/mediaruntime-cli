import { createHash, randomBytes } from "node:crypto";
import {
  AuthApiError,
  exchangeAuthorization,
  inspectCredential,
  revokeCredential,
  startAuthorization,
} from "../auth/api.js";
import { openBrowser } from "../auth/browser.js";
import {
  OsCredentialStore,
  type CredentialStore,
  type StoredCredential,
} from "../auth/credential-store.js";
import { CliError, UsageError } from "../errors.js";

export interface AuthCommandDependencies {
  credentialStore?: CredentialStore;
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  randomVerifier?: () => string;
  writeStdout?: (text: string) => void;
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function verifierChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function defaultVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function store(dependencies: AuthCommandDependencies): CredentialStore {
  return dependencies.credentialStore ?? new OsCredentialStore();
}

function assertOnly(args: string[], allowed: string[]): void {
  const unexpected = args.find((arg) => !allowed.includes(arg));
  if (unexpected) throw new UsageError(`Unknown authentication option: ${unexpected}`);
}

export async function resolveCredential(
  baseUrl: string,
  dependencies: AuthCommandDependencies = {},
): Promise<{ apiKey: string; source: "environment" | "keychain"; stored?: StoredCredential } | null> {
  const environment = process.env.MEDIARUNTIME_API_KEY?.trim();
  if (environment) return { apiKey: environment, source: "environment" };
  const stored = await store(dependencies).get(baseUrl);
  return stored ? { apiKey: stored.apiKey, source: "keychain", stored } : null;
}

export async function runLoginCommand(
  args: string[],
  baseUrl: string,
  dependencies: AuthCommandDependencies = {},
): Promise<number> {
  assertOnly(args, ["--no-browser"]);
  const noBrowser = args.includes("--no-browser");
  const write = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const existing = await store(dependencies).get(baseUrl);
  if (existing) {
    try {
      await inspectCredential(baseUrl, existing.apiKey);
      write(`Already logged in to ${baseUrl} (account ${existing.accountId}).\n`);
      return 0;
    } catch (error) {
      if (!(error instanceof AuthApiError) || error.status >= 500) throw error;
    }
  }

  const verifier = dependencies.randomVerifier?.() ?? defaultVerifier();
  if (verifier.length < 43 || verifier.length > 128) {
    throw new CliError("invalid_verifier", "Generated PKCE verifier is invalid", 1);
  }
  const authorization = await startAuthorization(baseUrl, verifierChallenge(verifier));
  if (!Number.isFinite(authorization.expiresIn) || authorization.expiresIn <= 0 ||
      !Number.isFinite(authorization.interval) || authorization.interval < 1) {
    throw new CliError("invalid_auth_response", "MediaRuntime returned invalid authorization timing", 5);
  }

  write(`Open this URL to authorize MediaRuntime CLI:\n${authorization.verificationUriComplete}\n\n`);
  write(`Confirm code: ${authorization.userCode}\n`);
  if (!noBrowser) await (dependencies.openBrowser ?? openBrowser)(authorization.verificationUriComplete);
  write("Waiting for browser approval…\n");

  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const deadline = now() + authorization.expiresIn * 1000;
  let credential;
  while (now() < deadline) {
    try {
      credential = await exchangeAuthorization(baseUrl, authorization.deviceCode, verifier);
      break;
    } catch (error) {
      if (error instanceof AuthApiError && error.code === "authorization_pending") {
        await sleep(authorization.interval * 1000);
        continue;
      }
      throw error;
    }
  }
  if (!credential) throw new CliError("authorization_timeout", "Browser authorization expired; run mediaruntime login again", 7);

  try {
    await inspectCredential(baseUrl, credential.apiKey);
    await store(dependencies).set({
      apiKey: credential.apiKey,
      accountId: credential.accountId,
      keyId: credential.keyId,
      baseUrl,
      createdAt: new Date(now()).toISOString(),
    });
  } catch (error) {
    await revokeCredential(baseUrl, credential.apiKey).catch(() => undefined);
    throw error;
  }

  write(`Logged in to ${baseUrl} (account ${credential.accountId}).\n`);
  if (process.env.MEDIARUNTIME_API_KEY?.trim()) {
    write("MEDIARUNTIME_API_KEY is set and will take precedence over this login.\n");
  }
  return 0;
}

export async function runAuthStatusCommand(
  args: string[],
  baseUrl: string,
  dependencies: AuthCommandDependencies = {},
): Promise<number> {
  assertOnly(args, ["--json"]);
  const json = args.includes("--json");
  const write = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const resolved = await resolveCredential(baseUrl, dependencies);
  if (!resolved) throw new CliError("authentication_required", "Run mediaruntime login or set MEDIARUNTIME_API_KEY", 3);
  const status = await inspectCredential(baseUrl, resolved.apiKey);
  if (json) {
    write(`${JSON.stringify({ authenticated: true, source: resolved.source, ...status })}\n`);
  } else {
    write(`Authenticated via ${resolved.source} (account ${status.accountId}, key ${status.keyId}).\n`);
  }
  return 0;
}

export async function runLogoutCommand(
  args: string[],
  baseUrl: string,
  dependencies: AuthCommandDependencies = {},
): Promise<number> {
  assertOnly(args, ["--local-only"]);
  const localOnly = args.includes("--local-only");
  const write = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const credentialStore = store(dependencies);
  const credential = await credentialStore.get(baseUrl);
  if (!credential) {
    write(`No stored login for ${baseUrl}.\n`);
    if (process.env.MEDIARUNTIME_API_KEY?.trim()) write("MEDIARUNTIME_API_KEY remains active in this shell.\n");
    return 0;
  }
  if (!localOnly) await revokeCredential(baseUrl, credential.apiKey);
  await credentialStore.delete(baseUrl);
  write(localOnly ? "Removed the local CLI login without server revocation.\n" : "Logged out and revoked the CLI credential.\n");
  if (process.env.MEDIARUNTIME_API_KEY?.trim()) write("MEDIARUNTIME_API_KEY remains active in this shell.\n");
  return 0;
}

export async function runAuthCommand(
  args: string[],
  baseUrl: string,
  dependencies: AuthCommandDependencies = {},
): Promise<number> {
  const subcommand = args[0];
  if (subcommand !== "status") throw new UsageError("Usage: mediaruntime auth status [--json]");
  return runAuthStatusCommand(args.slice(1), baseUrl, dependencies);
}
