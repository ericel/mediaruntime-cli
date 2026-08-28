import type {
  Capabilities,
  CreateJobParams,
  JobDetails,
  JobOutput,
  JobReceiptData,
  Metadata,
  OutputAlias,
  WaitForJobOptions,
} from "@mediaruntime/node";
import type { CapabilitiesReadClient } from "./capabilities.js";
import { BundleDownloadError, UsageError } from "../errors.js";
import type { ActivityIndicator } from "../ui/activity.js";

const UNSUCCESSFUL_TERMINAL_STATUSES = new Set(["FAILED", "REJECTED", "PARTIAL"]);
// Fast-path aliases are stable CLI inputs; preset metadata is still fetched from capabilities.
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

export interface RunUploadsClient {
  resolveSource(source: string): Promise<string>;
}

export interface RunCommandDependencies {
  jobs: RunJobsClient;
  capabilities: CapabilitiesReadClient;
  uploads?: RunUploadsClient;
  writeStdout(text: string): void;
  activity: ActivityIndicator;
  downloadBundle(
    url: string,
    destination: string,
    options: { force: boolean; expectedSizeBytes?: number | null; expectedSha256?: string | null },
  ): Promise<void>;
}

interface RunOptions {
  source: string;
  outputs: Array<{ kind: "alias" | "preset"; value: string }>;
  recipe?: string;
  metadata?: Metadata;
  idempotencyKey?: string;
  wait: boolean;
  timeoutMs?: number;
  download?: string;
  force: boolean;
  json: boolean;
  animation?: {
    width?: number;
    fps?: number;
    startTime?: number;
    duration?: number;
    loop?: number;
    quality?: number;
  };
  placeholders?: {
    maxDimension?: number;
    sourceTimeSec?: number;
    lqipQuality?: number;
    lqipMaxBytes?: number;
  };
  contactSheet?: {
    columns?: number;
    rows?: number;
    tileWidth?: number;
    tileHeight?: number;
    intervalSec?: number;
    startTimeSec?: number;
    durationSec?: number;
    maxSheets?: number;
    format?: "jpg" | "png" | "webp";
    quality?: number;
  };
  image?: {
    width?: number;
    height?: number;
    mode?: "fit" | "fill" | "cover" | "contain";
    format?: "jpg" | "png" | "webp" | "avif";
    quality?: number;
    maxBytes?: number;
    minQuality?: number;
  };
  audiogram?: {
    artworkSource: string;
    captionsSource?: string;
    layout?: "square" | "portrait" | "landscape";
    artworkFit?: "contain" | "cover" | "blurred_background";
    backgroundColor?: string;
    waveformColor?: string;
    waveformGain?: number;
    startTimeSec?: number;
    durationSec?: number;
    fps?: number;
    burnCaptions?: boolean;
    captionPosition?: "top" | "bottom";
    captionFontScale?: number;
    normalizeAudio?: boolean;
    loudnessTargetLufs?: number;
  };
  privacyRedaction?: {
    detectors: Array<"face" | "license_plate" | "text">;
    style?: "blur" | "pixelate" | "solid";
    failureMode?: "fail_closed" | "report_only";
    minConfidence?: number;
    sampleIntervalSec?: number;
    maxFrames?: number;
    boxPaddingRatio?: number;
    solidColor?: string;
    pixelBlockSize?: number;
    privacyStrength?: "standard" | "strong";
    includeDebugObservations?: boolean;
  };
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

function boundedNumber(
  args: string[],
  index: number,
  option: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const value = Number(optionValue(args, index, option));
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new UsageError(`${option} must be ${integer ? "an integer " : ""}between ${minimum} and ${maximum}`);
  }
  return value;
}

function hexColor(args: string[], index: number, option: string): string {
  const value = optionValue(args, index, option);
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new UsageError(`${option} must be a six-digit hex colour such as #5B5CFF`);
  }
  return value;
}

function parseRunOptions(args: string[]): RunOptions {
  let source: string | undefined;
  const outputs: RunOptions["outputs"] = [];
  let metadata: Metadata | undefined;
  let recipe: string | undefined;
  let idempotencyKey: string | undefined;
  let wait = false;
  let timeoutMs: number | undefined;
  let download: string | undefined;
  let force = false;
  let json = false;
  const animation: NonNullable<RunOptions["animation"]> = {};
  const placeholders: NonNullable<RunOptions["placeholders"]> = {};
  const contactSheet: NonNullable<RunOptions["contactSheet"]> = {};
  const image: NonNullable<RunOptions["image"]> = {};
  const audiogram: Partial<NonNullable<RunOptions["audiogram"]>> = {};
  const privacyRedaction: Partial<NonNullable<RunOptions["privacyRedaction"]>> = {};
  const privacyDetectors: Array<"face" | "license_plate" | "text"> = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output" || argument === "-o") {
      outputs.push({ kind: "alias", value: optionValue(args, index, argument) });
      index += 1;
    } else if (argument === "--preset") {
      outputs.push({ kind: "preset", value: optionValue(args, index, argument) });
      index += 1;
    } else if (argument === "--recipe") {
      recipe = optionValue(args, index, argument);
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
    } else if (argument === "--animation-width") {
      animation.width = boundedNumber(args, index, argument, 1, 1920, true);
      index += 1;
    } else if (argument === "--animation-fps") {
      animation.fps = boundedNumber(args, index, argument, 0.01, 30);
      index += 1;
    } else if (argument === "--animation-start") {
      animation.startTime = boundedNumber(args, index, argument, 0, 604800);
      index += 1;
    } else if (argument === "--animation-duration") {
      animation.duration = boundedNumber(args, index, argument, 0.01, 30);
      index += 1;
    } else if (argument === "--animation-loop") {
      animation.loop = boundedNumber(args, index, argument, 0, 65535, true);
      index += 1;
    } else if (argument === "--animation-quality") {
      animation.quality = boundedNumber(args, index, argument, 1, 100, true);
      index += 1;
    } else if (argument === "--placeholder-max-dimension") {
      placeholders.maxDimension = boundedNumber(args, index, argument, 8, 100, true);
      index += 1;
    } else if (argument === "--placeholder-time") {
      placeholders.sourceTimeSec = boundedNumber(args, index, argument, 0, 604800);
      index += 1;
    } else if (argument === "--lqip-quality") {
      placeholders.lqipQuality = boundedNumber(args, index, argument, 1, 100, true);
      index += 1;
    } else if (argument === "--lqip-max-bytes") {
      placeholders.lqipMaxBytes = boundedNumber(args, index, argument, 256, 16384, true);
      index += 1;
    } else if (argument === "--contact-columns") {
      contactSheet.columns = boundedNumber(args, index, argument, 1, 10, true);
      index += 1;
    } else if (argument === "--contact-rows") {
      contactSheet.rows = boundedNumber(args, index, argument, 1, 10, true);
      index += 1;
    } else if (argument === "--contact-tile-width") {
      contactSheet.tileWidth = boundedNumber(args, index, argument, 64, 640, true);
      index += 1;
    } else if (argument === "--contact-tile-height") {
      contactSheet.tileHeight = boundedNumber(args, index, argument, 36, 640, true);
      index += 1;
    } else if (argument === "--contact-interval") {
      contactSheet.intervalSec = boundedNumber(args, index, argument, 0.5, 3600);
      index += 1;
    } else if (argument === "--contact-start") {
      contactSheet.startTimeSec = boundedNumber(args, index, argument, 0, 604800);
      index += 1;
    } else if (argument === "--contact-duration") {
      contactSheet.durationSec = boundedNumber(args, index, argument, 0, 21600);
      index += 1;
    } else if (argument === "--contact-max-sheets") {
      contactSheet.maxSheets = boundedNumber(args, index, argument, 1, 20, true);
      index += 1;
    } else if (argument === "--contact-format") {
      const value = optionValue(args, index, argument);
      if (value !== "jpg" && value !== "png" && value !== "webp") {
        throw new UsageError("--contact-format must be jpg, png, or webp");
      }
      contactSheet.format = value;
      index += 1;
    } else if (argument === "--contact-quality") {
      contactSheet.quality = boundedNumber(args, index, argument, 1, 100, true);
      index += 1;
    } else if (argument === "--image-width") {
      image.width = boundedNumber(args, index, argument, 1, 16384, true);
      index += 1;
    } else if (argument === "--image-height") {
      image.height = boundedNumber(args, index, argument, 1, 16384, true);
      index += 1;
    } else if (argument === "--image-mode") {
      const value = optionValue(args, index, argument);
      if (value !== "fit" && value !== "fill" && value !== "cover" && value !== "contain") {
        throw new UsageError("--image-mode must be fit, fill, cover, or contain");
      }
      image.mode = value;
      index += 1;
    } else if (argument === "--image-format") {
      const value = optionValue(args, index, argument);
      if (value !== "jpg" && value !== "png" && value !== "webp" && value !== "avif") {
        throw new UsageError("--image-format must be jpg, png, webp, or avif");
      }
      image.format = value;
      index += 1;
    } else if (argument === "--image-quality") {
      image.quality = boundedNumber(args, index, argument, 1, 100, true);
      index += 1;
    } else if (argument === "--image-max-bytes") {
      image.maxBytes = boundedNumber(args, index, argument, 256, 100_000_000, true);
      index += 1;
    } else if (argument === "--image-min-quality") {
      image.minQuality = boundedNumber(args, index, argument, 1, 100, true);
      index += 1;
    } else if (argument === "--audiogram-artwork") {
      audiogram.artworkSource = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--audiogram-captions") {
      audiogram.captionsSource = optionValue(args, index, argument);
      audiogram.burnCaptions = true;
      index += 1;
    } else if (argument === "--audiogram-layout") {
      const value = optionValue(args, index, argument);
      if (value !== "square" && value !== "portrait" && value !== "landscape") {
        throw new UsageError("--audiogram-layout must be square, portrait, or landscape");
      }
      audiogram.layout = value;
      index += 1;
    } else if (argument === "--audiogram-background") {
      audiogram.backgroundColor = hexColor(args, index, argument);
      index += 1;
    } else if (argument === "--audiogram-waveform") {
      audiogram.waveformColor = hexColor(args, index, argument);
      index += 1;
    } else if (argument === "--audiogram-fit") {
      const value = optionValue(args, index, argument);
      if (value !== "contain" && value !== "cover" && value !== "blurred_background") {
        throw new UsageError("--audiogram-fit must be contain, cover, or blurred_background");
      }
      audiogram.artworkFit = value;
      index += 1;
    } else if (argument === "--audiogram-waveform-gain") {
      audiogram.waveformGain = boundedNumber(args, index, argument, 0.5, 4);
      index += 1;
    } else if (argument === "--audiogram-caption-position") {
      const value = optionValue(args, index, argument);
      if (value !== "top" && value !== "bottom") {
        throw new UsageError("--audiogram-caption-position must be top or bottom");
      }
      audiogram.captionPosition = value;
      index += 1;
    } else if (argument === "--audiogram-caption-scale") {
      audiogram.captionFontScale = boundedNumber(args, index, argument, 0.75, 1.5);
      index += 1;
    } else if (argument === "--audiogram-normalize") {
      audiogram.normalizeAudio = true;
    } else if (argument === "--audiogram-loudness-target") {
      audiogram.loudnessTargetLufs = boundedNumber(args, index, argument, -24, -12);
      index += 1;
    } else if (argument === "--audiogram-start") {
      audiogram.startTimeSec = boundedNumber(args, index, argument, 0, 604800);
      index += 1;
    } else if (argument === "--audiogram-duration") {
      audiogram.durationSec = boundedNumber(args, index, argument, 0.1, 300);
      index += 1;
    } else if (argument === "--audiogram-fps") {
      audiogram.fps = boundedNumber(args, index, argument, 15, 30, true);
      index += 1;
    } else if (argument === "--privacy-detector") {
      const value = optionValue(args, index, argument);
      if (value !== "face" && value !== "license_plate" && value !== "text") {
        throw new UsageError("--privacy-detector must be face, license_plate, or text");
      }
      if (privacyDetectors.includes(value)) {
        throw new UsageError(`Duplicate --privacy-detector: ${value}`);
      }
      privacyDetectors.push(value);
      index += 1;
    } else if (argument === "--privacy-style") {
      const value = optionValue(args, index, argument);
      if (value !== "blur" && value !== "pixelate" && value !== "solid") {
        throw new UsageError("--privacy-style must be blur, pixelate, or solid");
      }
      privacyRedaction.style = value;
      index += 1;
    } else if (argument === "--privacy-failure-mode") {
      const value = optionValue(args, index, argument);
      if (value !== "fail_closed" && value !== "report_only") {
        throw new UsageError("--privacy-failure-mode must be fail_closed or report_only");
      }
      privacyRedaction.failureMode = value;
      index += 1;
    } else if (argument === "--privacy-min-confidence") {
      privacyRedaction.minConfidence = boundedNumber(args, index, argument, 0.3, 0.99);
      index += 1;
    } else if (argument === "--privacy-sample-interval") {
      privacyRedaction.sampleIntervalSec = boundedNumber(args, index, argument, 0.1, 30);
      index += 1;
    } else if (argument === "--privacy-max-frames") {
      privacyRedaction.maxFrames = boundedNumber(args, index, argument, 1, 18000, true);
      index += 1;
    } else if (argument === "--privacy-padding") {
      privacyRedaction.boxPaddingRatio = boundedNumber(args, index, argument, 0, 0.5);
      index += 1;
    } else if (argument === "--privacy-solid-color") {
      privacyRedaction.solidColor = hexColor(args, index, argument);
      index += 1;
    } else if (argument === "--privacy-pixel-block-size") {
      privacyRedaction.pixelBlockSize = boundedNumber(args, index, argument, 4, 128, true);
      index += 1;
    } else if (argument === "--privacy-strength") {
      const value = optionValue(args, index, argument);
      if (value !== "standard" && value !== "strong") {
        throw new UsageError("--privacy-strength must be standard or strong");
      }
      privacyRedaction.privacyStrength = value;
      index += 1;
    } else if (argument === "--privacy-debug-observations") {
      privacyRedaction.includeDebugObservations = true;
    } else if (argument?.startsWith("-")) {
      throw new UsageError(`Unknown run option: ${argument}`);
    } else if (source === undefined) {
      source = argument;
    } else {
      throw new UsageError("run accepts exactly one source");
    }
  }

  if (!source) {
    throw new UsageError("Usage: mediaruntime run <source> (--recipe <name[@version]> | --output <alias> | --preset <name>) [--wait]");
  }
  if (recipe && outputs.length > 0) throw new UsageError("--recipe cannot be combined with --output or --preset");
  if (!recipe && outputs.length === 0) throw new UsageError("run requires --recipe or at least one --output or --preset");
  const unsupported = outputs.find(
    (output) => output.kind === "alias" && !OUTPUT_ALIASES.has(output.value),
  );
  if (unsupported) throw new UsageError(`Unsupported output alias: ${unsupported.value}`);
  if (force && !download) throw new UsageError("--force requires --download");
  if (timeoutMs !== undefined && !wait) throw new UsageError("--timeout-ms requires --wait or --download");
  const hasAnimationOptions = Object.keys(animation).length > 0;
  if (hasAnimationOptions) {
    const animationSelections = outputs.filter(
      (output) => output.kind === "preset" &&
        (output.value === "image_animated_webp_v1" || output.value === "image_animated_apng_v1"),
    );
    if (recipe || outputs.length !== 1 || animationSelections.length !== 1) {
      throw new UsageError("animation options require exactly one animated WebP or APNG --preset");
    }
    if (animation.quality !== undefined && animationSelections[0]?.value === "image_animated_apng_v1") {
      throw new UsageError("--animation-quality applies to animated WebP only; APNG is lossless");
    }
  }
  const hasPlaceholderOptions = Object.keys(placeholders).length > 0;
  if (hasPlaceholderOptions) {
    const placeholderSelections = outputs.filter(
      (output) => output.kind === "preset" && output.value === "image_placeholders_v1",
    );
    if (recipe || outputs.length !== 1 || placeholderSelections.length !== 1) {
      throw new UsageError("placeholder options require exactly one image_placeholders_v1 --preset");
    }
  }
  const hasContactSheetOptions = Object.keys(contactSheet).length > 0;
  if (hasContactSheetOptions) {
    const selections = outputs.filter(
      (output) => output.kind === "preset" && output.value === "contact_sheet_v1",
    );
    if (recipe || outputs.length !== 1 || selections.length !== 1) {
      throw new UsageError("contact-sheet options require exactly one contact_sheet_v1 --preset");
    }
    const geometry = {
      columns: 4,
      rows: 4,
      tileWidth: 320,
      tileHeight: 180,
      ...contactSheet,
    };
    if (geometry.columns * geometry.tileWidth > 4096 || geometry.rows * geometry.tileHeight > 4096) {
      throw new UsageError("contact-sheet width and height must each be at most 4096 pixels");
    }
    if (contactSheet.format === "png" && contactSheet.quality !== undefined) {
      throw new UsageError("--contact-quality applies to JPG and WebP only; PNG is lossless");
    }
  }
  const hasImageOptions = Object.keys(image).length > 0;
  if (hasImageOptions) {
    const selections = outputs.filter(
      (output) => output.kind === "preset" && output.value === "image_multi_v1",
    );
    if (recipe || outputs.length !== 1 || selections.length !== 1) {
      throw new UsageError("image rendition options require exactly one image_multi_v1 --preset");
    }
    if (image.minQuality !== undefined && image.maxBytes === undefined) {
      throw new UsageError("--image-min-quality requires --image-max-bytes");
    }
    const quality = image.quality ?? 80;
    if ((image.minQuality ?? 1) > quality) {
      throw new UsageError("--image-min-quality must not exceed --image-quality");
    }
    const format = image.format ?? "webp";
    if (image.maxBytes !== undefined && format !== "jpg" && format !== "webp") {
      throw new UsageError("--image-max-bytes currently supports --image-format jpg or webp only");
    }
  }
  const audiogramSelections = outputs.filter(
    (output) => output.kind === "preset" && output.value === "audiogram_v1",
  );
  const hasAudiogramOptions = Object.keys(audiogram).length > 0;
  if (hasAudiogramOptions || audiogramSelections.length > 0) {
    if (recipe || outputs.length !== 1 || audiogramSelections.length !== 1) {
      throw new UsageError("audiogram options require exactly one audiogram_v1 --preset");
    }
    if (!audiogram.artworkSource) {
      throw new UsageError("audiogram_v1 requires --audiogram-artwork <PNG|JPEG|WebP source>");
    }
  }
  const hasPrivacyOptions = privacyDetectors.length > 0 || Object.keys(privacyRedaction).length > 0;
  if (hasPrivacyOptions) {
    if (recipe) throw new UsageError("privacy-redaction options cannot be combined with --recipe");
    if (privacyDetectors.length === 0) {
      throw new UsageError("privacy redaction requires at least one --privacy-detector");
    }
    if (/\.(?:mp4|mov|mkv|webm|gif|apng)(?:$|[?#])/i.test(source)) {
      throw new UsageError(
        "privacy redaction Preview accepts still-image inputs only; video and animated images are not available",
      );
    }
    privacyRedaction.detectors = privacyDetectors;
  }
  return {
    source,
    outputs,
    ...(recipe === undefined ? {} : { recipe }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    wait,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(download === undefined ? {} : { download }),
    force,
    json,
    ...(hasAnimationOptions ? { animation } : {}),
    ...(hasPlaceholderOptions ? { placeholders } : {}),
    ...(hasContactSheetOptions ? { contactSheet } : {}),
    ...(hasImageOptions ? { image } : {}),
    ...(hasAudiogramOptions || audiogramSelections.length > 0
      ? { audiogram: audiogram as NonNullable<RunOptions["audiogram"]> }
      : {}),
    ...(hasPrivacyOptions
      ? { privacyRedaction: privacyRedaction as NonNullable<RunOptions["privacyRedaction"]> }
      : {}),
  };
}

function isHostedAsset(source: string): boolean {
  return /^(?:https?|gs):\/\//i.test(source);
}

async function resolveAudiogramAsset(
  source: string,
  label: "artwork" | "captions",
  uploads?: RunUploadsClient,
): Promise<string> {
  if (isHostedAsset(source)) return source;
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^file:\/\//i.test(source)) {
    throw new UsageError(`Audiogram ${label} must be an HTTP(S) URL, gs:// URI, or local file path`);
  }
  if (!uploads) {
    throw new UsageError(`This client cannot upload local Audiogram ${label}; use an HTTP(S) URL or gs:// URI`);
  }
  // Upload local artwork/captions through the SDK before embedding their private source URI.
  return await uploads.resolveSource(source);
}

async function resolveAudiogram(
  value: NonNullable<RunOptions["audiogram"]>,
  uploads?: RunUploadsClient,
): Promise<NonNullable<RunOptions["audiogram"]>> {
  const artworkSource = await resolveAudiogramAsset(value.artworkSource, "artwork", uploads);
  const captionsSource = value.captionsSource === undefined
    ? undefined
    : await resolveAudiogramAsset(value.captionsSource, "captions", uploads);
  return {
    ...value,
    artworkSource,
    ...(captionsSource === undefined ? {} : { captionsSource, burnCaptions: true }),
  };
}

async function resolveOutputs(
  selections: RunOptions["outputs"],
  capabilitiesClient: CapabilitiesReadClient,
  animation?: RunOptions["animation"],
  placeholders?: RunOptions["placeholders"],
  contactSheet?: RunOptions["contactSheet"],
  image?: RunOptions["image"],
  audiogram?: RunOptions["audiogram"],
  privacyRedaction?: RunOptions["privacyRedaction"],
): Promise<Array<OutputAlias | JobOutput>> {
  // Plain aliases need no expansion; preset-specific options require authoritative metadata.
  if (!privacyRedaction && !selections.some((selection) => selection.kind === "preset")) {
    return selections.map((selection) => selection.value as OutputAlias);
  }
  const capabilities: Capabilities = await capabilitiesClient.retrieve();
  const publicPresets = new Set(capabilities.publicPresets);
  return selections.map((selection) => {
    if (selection.kind === "alias" && !privacyRedaction) {
      return selection.value as OutputAlias;
    }
    const selectedName = selection.kind === "alias"
      ? capabilities.outputAliases[selection.value]?.preset
      : selection.value;
    const preset = selectedName ? capabilities.presets[selectedName] : undefined;
    if (!selectedName || !publicPresets.has(selectedName) || !preset) {
      throw new UsageError(selection.kind === "alias"
        ? `Gateway did not provide a public expansion for alias: ${selection.value}`
        : `Unknown or non-public preset: ${selection.value}`);
    }
    if (privacyRedaction && preset.outputType !== "image") {
      throw new UsageError(
        "privacy redaction Preview can be attached to image outputs only",
      );
    }
    const output = { type: preset.outputType, preset: selectedName } as JobOutput & {
      animation?: RunOptions["animation"];
      placeholders?: RunOptions["placeholders"];
      contactSheet?: RunOptions["contactSheet"];
      images?: Array<{
        width: number;
        height: number;
        mode: "fit" | "fill" | "cover" | "contain";
        format: "jpg" | "png" | "webp" | "avif";
        quality: number;
        maxBytes?: number;
        minQuality?: number;
      }>;
      audiogram?: RunOptions["audiogram"];
      privacyRedaction?: RunOptions["privacyRedaction"];
    };
    if (animation) output.animation = animation;
    if (placeholders) output.placeholders = placeholders;
    if (contactSheet) output.contactSheet = contactSheet;
    if (image) {
      output.images = [{
        width: image.width ?? 1280,
        height: image.height ?? 720,
        mode: image.mode ?? "fit",
        format: image.format ?? "webp",
        quality: image.quality ?? 80,
        ...(image.maxBytes === undefined ? {} : { maxBytes: image.maxBytes }),
        ...(image.maxBytes === undefined ? {} : { minQuality: image.minQuality ?? 1 }),
      }];
    }
    if (audiogram) output.audiogram = audiogram;
    if (privacyRedaction) output.privacyRedaction = privacyRedaction;
    return output;
  });
}

function receiptProjection(job: SubmittedJob): JobReceiptData {
  return {
    id: job.id,
    status: job.status,
    tier: job.tier,
    requiredTier: job.requiredTier,
    outputs: job.outputs,
    recipe: job.recipe,
    message: job.message,
  };
}

function detailsProjection(job: JobDetails): Record<string, unknown> {
  // Redact the signed bundle URL from --json; expose only lifecycle and integrity metadata.
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
    recipe: job.recipe,
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
  const hasLocalAudiogramAsset = options.audiogram !== undefined &&
    (!isHostedAsset(options.audiogram.artworkSource) ||
      (options.audiogram.captionsSource !== undefined && !isHostedAsset(options.audiogram.captionsSource)));
  const isLocalSource = !isHostedAsset(options.source);
  dependencies.activity.start(
    isLocalSource || hasLocalAudiogramAsset
      ? "Uploading local media and creating job…"
      : "Creating job…",
  );

  try {
    // Auxiliary local files are resolved first so the submitted job contains durable sources.
    const audiogram = options.audiogram === undefined
      ? undefined
      : await resolveAudiogram(options.audiogram, dependencies.uploads);
    const outputs = options.recipe
      ? undefined
      : await resolveOutputs(
          options.outputs,
          dependencies.capabilities,
          options.animation,
          options.placeholders,
          options.contactSheet,
          options.image,
          audiogram,
          options.privacyRedaction,
        );
    const params: CreateJobParams = {
      source: options.source,
      ...(outputs === undefined ? {} : { outputs }),
      ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    };
    const submitted = await dependencies.jobs.create(params);

    if (!options.wait) {
      // Submission-only mode returns immediately; production services should prefer webhooks.
      dependencies.activity.stop();
      if (options.json) dependencies.writeStdout(`${JSON.stringify(receiptProjection(submitted))}\n`);
      else writeHumanReceipt(submitted, dependencies.writeStdout);
      return UNSUCCESSFUL_TERMINAL_STATUSES.has(String(submitted.status).toUpperCase()) ? 6 : 0;
    }

    dependencies.activity.update(`Waiting for job ${submitted.id} to complete…`);
    const details = await submitted.wait(
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
    if (String(details.status).toUpperCase() !== "COMPLETED") {
      dependencies.activity.stop();
      if (!options.json) writeHumanDetails(details, dependencies.writeStdout);
      if (options.json) dependencies.writeStdout(`${JSON.stringify(detailsProjection(details))}\n`);
      return 6;
    }
    if (options.download) {
      const url = details.bundle.downloadUrl;
      if (!details.bundle.available || !url) {
        throw new BundleDownloadError("Completed job does not have an available canonical bundle");
      }
      dependencies.activity.update("Downloading and verifying ZIP bundle…");
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
    }
    dependencies.activity.stop();
    if (!options.json) {
      writeHumanDetails(details, dependencies.writeStdout);
      if (options.download) dependencies.writeStdout(`Downloaded bundle to ${options.download}\n`);
    }
    if (options.json) dependencies.writeStdout(`${JSON.stringify(detailsProjection(details))}\n`);
    return 0;
  } finally {
    dependencies.activity.stop();
  }
}
