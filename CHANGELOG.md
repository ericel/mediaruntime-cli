# Changelog

## Unreleased

- Add explicit, bounded still-image Privacy Redaction Preview flags for face, license-plate, and visible-text
  masking; aliases are expanded through the live capability catalog before submission.
- Document the stable public privacy-report boundary and its ZIP-relative paths while
  excluding detector/model and private infrastructure details.
- Add bounded Audiogram artwork-fit, waveform-gain, safe-caption, and optional loudness
  normalization flags; document the caption-free poster artifact.
- Document capability-driven `code_detect_v1` execution and its untrusted-payload rule.
- Document and regression-test capability-driven `compatibility_report_v1` execution.
- Add bounded `contact_sheet_v1` run controls for grid geometry, sampling window, sheet
  count, format, and quality.

## 1.2.0 — 2026-08-19

- Add hosted recipe discovery, inspection, creation, immutable versioning, and archive
  commands.
- Add `run --recipe <name[@version]>` with local-file upload, waiting, and safe ZIP
  download behavior identical to inline output jobs.
- Keep recipe submission mutually exclusive with `--output` and `--preset`.
- Upgrade to `@mediaruntime/node` 1.2.0.

## 1.1.0 — 2026-08-18

- Add unauthenticated `capabilities` and `presets list` discovery commands backed by the
  live gateway contract.
- Add repeated `--preset <public-preset>` execution while preserving `-o` and `--output`
  for the six frozen aliases.
- Resolve preset output types from the gateway's ordered public catalog instead of
  copying engine preset metadata into the CLI.
- Upgrade to `@mediaruntime/node` 1.1.1 capability contracts.

## 1.0.0 — 2026-08-16

- Declare the documented CLI surface stable under semantic versioning, including command
  names, flags, JSON envelopes, exit codes, and credential precedence.
- Require supported Node.js 22 or newer runtimes and depend on `@mediaruntime/node` 1.x.
- Point legacy package tooling at the shipped executable instead of a nonexistent entry.
- Freeze local upload, browser authentication, job inspection, atomic ZIP download,
  interactive progress, and loopback webhook-trigger behavior as the v1 contract.

## 0.2.1 — 2026-08-16

- Show an elapsed-time activity spinner during interactive local upload, job waiting,
  and verified bundle download.
- Keep progress on `stderr` and disable it for JSON and non-interactive execution.
- Clarify that both relative and absolute local file paths are uploaded automatically.

## 0.2.0 — 2026-08-16

- Add browser-assisted `login`, `auth status`, and revoking `logout` commands.
- Store dedicated CLI credentials only in the operating-system credential vault.
- Keep `MEDIARUNTIME_API_KEY` as the higher-priority permanent automation interface.
- Bind the one-time exchange with PKCE and redact credentials from all CLI output.

## 0.1.0 — 2026-08-16

- Add `run` with local uploads, frozen output aliases, safe waiting, and atomic canonical
  ZIP downloads.
- Add `jobs list` and `jobs get` with human and URL-redacted JSON output.
- Add loopback-only `trigger` for correctly signed synthetic completion, failure, and
  rejection webhooks.
- Publish stable exit codes, credential rules, and the CLI software design contract.
