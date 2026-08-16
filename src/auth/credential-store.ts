import { CliError } from "../errors.js";

const SERVICE = "mediaruntime-cli";

export interface StoredCredential {
  apiKey: string;
  accountId: string;
  keyId: string;
  baseUrl: string;
  createdAt: string;
}

export interface CredentialStore {
  get(baseUrl: string): Promise<StoredCredential | null>;
  set(credential: StoredCredential): Promise<void>;
  delete(baseUrl: string): Promise<void>;
}

function vaultAccount(baseUrl: string): string {
  return new URL(baseUrl).host.toLowerCase();
}

function validCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.apiKey === "string" && item.apiKey.startsWith("sk_") &&
    typeof item.accountId === "string" && item.accountId.length > 0 &&
    typeof item.keyId === "string" && item.keyId.length > 0 &&
    typeof item.baseUrl === "string" && item.baseUrl.length > 0 &&
    typeof item.createdAt === "string" && item.createdAt.length > 0;
}

async function entry(baseUrl: string) {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(SERVICE, vaultAccount(baseUrl));
  } catch (error) {
    throw new CliError(
      "credential_store_unavailable",
      "The operating-system credential vault is unavailable; use MEDIARUNTIME_API_KEY on this machine",
      2,
      { cause: error },
    );
  }
}

export class OsCredentialStore implements CredentialStore {
  async get(baseUrl: string): Promise<StoredCredential | null> {
    try {
      const raw = (await entry(baseUrl)).getPassword();
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!validCredential(parsed) || parsed.baseUrl !== baseUrl) {
        throw new Error("Stored credential has an invalid shape");
      }
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message.includes("invalid shape"))) {
        throw new CliError("credential_store_invalid", "The stored MediaRuntime credential is invalid; run mediaruntime logout --local-only", 3);
      }
      if (error instanceof CliError) throw error;
      // Keyring implementations return a not-found error rather than null on some platforms.
      if (error instanceof Error && /not found|no entry|no matching|item.*exist/i.test(error.message)) return null;
      throw new CliError("credential_store_error", "Could not read the operating-system credential vault", 2, { cause: error });
    }
  }

  async set(credential: StoredCredential): Promise<void> {
    try {
      (await entry(credential.baseUrl)).setPassword(JSON.stringify(credential));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("credential_store_error", "Could not save the login in the operating-system credential vault", 2, { cause: error });
    }
  }

  async delete(baseUrl: string): Promise<void> {
    try {
      (await entry(baseUrl)).deletePassword();
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof Error && /not found|no entry|no matching|item.*exist/i.test(error.message)) return;
      throw new CliError("credential_store_error", "Could not remove the login from the operating-system credential vault", 2, { cause: error });
    }
  }
}
