export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UsageError extends CliError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("usage_error", message, 2, options);
    this.name = "UsageError";
  }
}

export class TriggerDeliveryError extends CliError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("trigger_delivery_error", message, 8, options);
    this.name = "TriggerDeliveryError";
  }
}

export class BundleDownloadError extends CliError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("bundle_download_error", message, 9, options);
    this.name = "BundleDownloadError";
  }
}
