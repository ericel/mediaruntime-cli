import { open } from "node:fs/promises";
import { UsageError } from "./errors.js";

const MAX_FILE_BYTES = 1024 * 1024;
type Segment = { startTimeSec: number; endTimeSec: number; text: string };

function timestamp(value: string): number {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
    throw new UsageError("Transcript cue times must use HH:MM:SS,mmm (SRT) or MM:SS.mmm / HH:MM:SS.mmm (VTT)");
  }
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

/** Flatten subtitle formatting just as the browser attachment flow does. */
function subtitleSegments(text: string, vtt: boolean): unknown[] {
  if (vtt && !/^WEBVTT(?:\s|$)/.test(text)) throw new UsageError("VTT transcripts must begin with WEBVTT");
  const segments: Segment[] = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    if (vtt && /^(WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) continue;
    const lines = block.split("\n");
    const timing = lines[0]?.includes("-->") ? 0 : 1;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timing] ?? "");
    if (!match) throw new UsageError("Transcript contains an invalid SRT/VTT cue");
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    const cue = lines.slice(timing + 1).join("\n").replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => entities[name]!);
    segments.push({ startTimeSec: timestamp(match[1]!), endTimeSec: timestamp(match[2]!), text: cue });
  }
  return segments;
}

/** Read a bounded local attachment. Its timestamps always refer to the full source. */
export async function readClipTranscript(path: string): Promise<Segment[]> {
  if (!/\.(json|srt|vtt)$/i.test(path)) throw new UsageError("--clip-transcript accepts a local .json, .srt, or .vtt file");
  let data: Buffer;
  try {
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) throw new UsageError("Clip transcript must be a regular file");
      // Bound the read itself as well as the parsed text, even if a file changes.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > MAX_FILE_BYTES) throw new UsageError("Clip transcript file must be at most 1 MiB");
      data = buffer.subarray(0, size);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("Cannot read clip transcript file; check its path and permissions");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim(); }
  catch { throw new UsageError("Clip transcript must be valid UTF-8 text"); }
  let segments: unknown;
  if (/\.json$/i.test(path)) {
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new UsageError("Clip transcript must be valid JSON"); }
    segments = Array.isArray(value) ? value : value && typeof value === "object" && "transcript" in value ? value.transcript : undefined;
  } else segments = subtitleSegments(text, /\.vtt$/i.test(path));
  if (!Array.isArray(segments) || !segments.length || segments.length > 2000) {
    throw new UsageError("Clip transcript must contain 1 to 2000 segments");
  }
  let previous = -1;
  let totalBytes = 0;
  return segments.map((value: unknown) => {
    const segment = value && typeof value === "object" ? value as Record<string, unknown> : {};
    // Downloaded reports use snake_case; Node SDK reports use camelCase.
    const start = segment.start_time_sec ?? segment.startTimeSec;
    const end = segment.end_time_sec ?? segment.endTimeSec;
    const cue = segment.text;
    if (typeof start !== "number" || !Number.isFinite(start) || typeof end !== "number" || !Number.isFinite(end) ||
        start < 0 || end <= start || end > 604800 || start < previous) {
      throw new UsageError("Transcript segments require ordered finite source times with end after start (within 604800 seconds)");
    }
    if (typeof cue !== "string" || !cue.trim() || Buffer.byteLength(cue, "utf8") > 2000) {
      throw new UsageError("Transcript segments require nonblank text of at most 2000 UTF-8 bytes");
    }
    previous = start;
    totalBytes += Buffer.byteLength(cue, "utf8");
    if (totalBytes > 256 * 1024) throw new UsageError("Transcript text exceeds 256 KiB");
    // Project only supported fields; renderer intersects and rebases these times.
    return { startTimeSec: start, endTimeSec: end, text: cue.trim() };
  });
}
