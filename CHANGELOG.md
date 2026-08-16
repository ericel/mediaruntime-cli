# Changelog

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
