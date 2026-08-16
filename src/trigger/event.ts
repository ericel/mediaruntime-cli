export const SUPPORTED_TRIGGER_EVENTS = [
  "job.completed",
  "job.failed",
  "job.rejected",
] as const;

export type TriggerEventType = (typeof SUPPORTED_TRIGGER_EVENTS)[number];

export function isTriggerEventType(value: string): value is TriggerEventType {
  return (SUPPORTED_TRIGGER_EVENTS as readonly string[]).includes(value);
}

export interface SyntheticEventOptions {
  eventId: string;
  jobId: string;
  accountId: string;
  timestamp: number;
}

export function createSyntheticTerminalEvent(
  type: TriggerEventType,
  options: SyntheticEventOptions,
): Record<string, unknown> {
  const status = type.slice("job.".length).toUpperCase();
  const occurredAt = new Date(options.timestamp * 1000).toISOString();
  const base = {
    event_id: options.eventId,
    job_id: options.jobId,
    account_id: options.accountId,
    status,
  };

  if (type === "job.completed") {
    const expiresAt = new Date((options.timestamp + 7 * 24 * 60 * 60) * 1000).toISOString();
    return {
      ...base,
      completedAt: occurredAt,
      delivery: {
        mode: "PULL",
        retentionDays: 7,
        expiresAt,
        bundle: {
          type: "zip",
          filename: `${options.jobId}_outputs.zip`,
          size_bytes: 0,
          sha256: "0".repeat(64),
          download: {
            url: `http://127.0.0.1/__mediaruntime_synthetic__/${encodeURIComponent(options.jobId)}.zip`,
            expiresAt,
          },
        },
        layout: "bundle_relative_v1",
        deliverables: [],
        manifests: {},
      },
      billing: { status: "PAID" },
      usage: { units_total: 0 },
      meta: { synthetic: true, request_metadata: {} },
    };
  }

  const failed = type === "job.failed";
  return {
    ...base,
    [failed ? "failedAt" : "rejectedAt"]: occurredAt,
    delivery: { mode: "NONE" },
    billing: { status: "RELEASED" },
    error: {
      code: failed ? "SYNTHETIC_ENGINE_FAILED" : "SYNTHETIC_REJECTED",
      message: `Synthetic ${type} event from the MediaRuntime CLI`,
    },
    meta: { synthetic: true, request_metadata: {} },
  };
}
