import { createHmac } from "node:crypto";

export const WEBHOOK_HEADERS = {
  id: "X-Transcoder-Id",
  timestamp: "X-Transcoder-Timestamp",
  signature: "X-Transcoder-Signature",
} as const;

export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

export function signSyntheticWebhook(
  payload: Readonly<Record<string, unknown>>,
  options: { eventId: string; timestamp: number; secret: string },
): SignedWebhook {
  if (!options.eventId.trim()) throw new Error("Webhook event ID must not be empty");
  if (!Number.isInteger(options.timestamp) || options.timestamp < 0) {
    throw new Error("Webhook timestamp must be a non-negative integer");
  }
  if (!options.secret) throw new Error("Webhook secret must not be empty");

  // JSON is serialized once. These exact bytes are both signed and sent.
  const body = JSON.stringify(payload);
  const bodyBytes = Buffer.from(body, "utf8");
  const prefix = Buffer.from(`${options.timestamp}.${options.eventId}.`, "utf8");
  const digest = createHmac("sha256", options.secret)
    .update(prefix)
    .update(bodyBytes)
    .digest("hex");

  return {
    body,
    headers: {
      "Content-Type": "application/json",
      [WEBHOOK_HEADERS.id]: options.eventId,
      [WEBHOOK_HEADERS.timestamp]: String(options.timestamp),
      [WEBHOOK_HEADERS.signature]: `t=${options.timestamp},v1=${digest}`,
    },
  };
}
