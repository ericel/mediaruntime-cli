import { CliError } from "../errors.js";

export const PRODUCTION_ORIGIN = "https://mediaruntime.com";

interface ErrorPayload {
  error?: unknown;
  detail?: unknown;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface IssuedCredential {
  apiKey: string;
  accountId: string;
  keyId: string;
  credentialType: "cli";
}

export interface CredentialStatus {
  status: "authenticated";
  accountId: string;
  keyId: string;
  credentialType: "cli" | "api_key";
}

export class AuthApiError extends CliError {
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(code, message, status >= 500 ? 5 : 3);
    this.name = "AuthApiError";
    this.status = status;
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/cli/auth/${path}`;
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function post(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  apiKey?: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(endpoint(baseUrl, path), {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new CliError("auth_connection_error", "Could not reach MediaRuntime authentication", 5, { cause: error });
  }
  const payload = await responsePayload(response);
  if (!response.ok) {
    const errorPayload = payload as ErrorPayload;
    throw new AuthApiError(
      typeof errorPayload.error === "string" ? errorPayload.error : "authorization_failed",
      typeof errorPayload.detail === "string" ? errorPayload.detail : `Authentication failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return payload;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new CliError("invalid_auth_response", "MediaRuntime returned an invalid authentication response", 5);
  return value;
}

export async function startAuthorization(baseUrl: string, codeChallenge: string): Promise<DeviceAuthorization> {
  const payload = await post(baseUrl, "start", { codeChallenge, clientName: "MediaRuntime CLI" });
  return {
    deviceCode: requireString(payload, "deviceCode"),
    userCode: requireString(payload, "userCode"),
    verificationUri: requireString(payload, "verificationUri"),
    verificationUriComplete: requireString(payload, "verificationUriComplete"),
    expiresIn: Number(payload.expiresIn),
    interval: Number(payload.interval),
  };
}

export async function exchangeAuthorization(baseUrl: string, deviceCode: string, codeVerifier: string): Promise<IssuedCredential> {
  const payload = await post(baseUrl, "token", { deviceCode, codeVerifier });
  const credentialType = requireString(payload, "credentialType");
  if (credentialType !== "cli") throw new CliError("invalid_auth_response", "MediaRuntime returned the wrong credential type", 5);
  return {
    apiKey: requireString(payload, "apiKey"),
    accountId: requireString(payload, "accountId"),
    keyId: requireString(payload, "keyId"),
    credentialType,
  };
}

export async function inspectCredential(baseUrl: string, apiKey: string): Promise<CredentialStatus> {
  const payload = await post(baseUrl, "status", {}, apiKey);
  const credentialType = requireString(payload, "credentialType");
  if (credentialType !== "cli" && credentialType !== "api_key") {
    throw new CliError("invalid_auth_response", "MediaRuntime returned the wrong credential type", 5);
  }
  return {
    status: "authenticated",
    accountId: requireString(payload, "accountId"),
    keyId: requireString(payload, "keyId"),
    credentialType,
  };
}

export async function revokeCredential(baseUrl: string, apiKey: string): Promise<void> {
  await post(baseUrl, "revoke", {}, apiKey);
}
