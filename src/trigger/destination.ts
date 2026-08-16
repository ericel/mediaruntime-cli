import { UsageError } from "../errors.js";

export function isLoopbackDestination(value: URL): boolean {
  let hostname = value.hostname.toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }

  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((part) => part >= 0 && part <= 255);
}

export function parseLocalDestination(raw: string): URL {
  let destination: URL;
  try {
    destination = new URL(raw);
  } catch {
    throw new UsageError("--to must be an absolute local HTTP(S) URL");
  }
  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw new UsageError("--to must use http:// or https://");
  }
  if (destination.username || destination.password) {
    throw new UsageError("--to must not contain URL credentials");
  }
  if (!isLoopbackDestination(destination)) {
    throw new UsageError(
      "trigger only sends to loopback destinations (localhost, 127.0.0.0/8, or ::1)",
    );
  }
  return destination;
}
