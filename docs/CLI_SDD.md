# MediaRuntime CLI software design

Status: stable public contract released as `1.2.0`

Package: `@mediaruntime/cli`

Executable: `mediaruntime`

Runtime: Node.js 22 or newer

## 1. Decision summary

The CLI is a thin, script-safe layer over the published `@mediaruntime/node` SDK. It
ships the media commands plus an interactive authentication surface:

```text
mediaruntime run <source> --output <alias>
mediaruntime run <source> --preset <public-preset>
mediaruntime capabilities
mediaruntime presets list
mediaruntime recipes list
mediaruntime recipes get <name>
mediaruntime recipes create --file <recipe.json>
mediaruntime recipes version <name> --file <recipe.json> --expected <version>
mediaruntime recipes archive <name>
mediaruntime jobs list
mediaruntime jobs get <job_id>
mediaruntime trigger job.completed --to http://127.0.0.1:3000/webhooks/mediaruntime
mediaruntime login
mediaruntime auth status
mediaruntime logout
```

`run` and `jobs` use the same production API, authentication, local-file upload,
idempotency, retry, error, and polling behavior as the Node SDK. `login` authorizes a
dedicated API key through the hosted browser flow defined in `docs/AUTH.md`. `trigger` is entirely
local: it creates and signs a synthetic terminal webhook without contacting the
MediaRuntime API.

The canonical result remains one expiring ZIP bundle containing the complete output tree.
The CLI downloads that ZIP as-is; it does not expose individual artifacts or infer an
engine directory layout.

## 2. Goals and non-goals

### Goals

- Make the first successful local-file transcode a single command.
- Give shell scripts stable job inspection, waiting, pagination, and exit behavior.
- Download the canonical ZIP safely without leaking credentials to the storage host.
- Let a developer exercise their local webhook receiver with the production signing
  protocol and realistic terminal payloads.
- Let interactive developers authorize in the browser and keep the resulting dedicated
  credential in the operating-system vault without weakening environment-key automation.
- Preserve the SDK and gateway as the authorities for request serialization, uploads,
  retries, aliases, status parsing, and API errors.

### Explicitly deferred

- `mediaruntime listen` is not a v1 command. It requires a multi-tenant relay,
  authenticated connections, event ownership, expiry, rate limits, and an abuse model.
- Named multi-account profiles are deferred. Browser login stores one credential per API
  origin; an explicit environment key remains the account override.
- Batch submission, arbitrary inline output-object editing, moderation, watermark management,
  webhook registration, media-report retrieval, and moderation-result retrieval remain
  available through the SDK/API but are not CLI v1 commands. Named public presets are
  supported through `--preset`; arbitrary output objects remain deferred.
- The CLI does not accept a per-job webhook URL. Terminal events go to the account-level
  destination configured in the MediaRuntime profile.
- ZIP extraction, artifact selectors, HLS serving, and indefinite bundle retention are
  out of scope.

## 3. Sources of truth

The implementation depends on the released Node SDK and must not copy its HTTP client.
The following published contracts govern the CLI:

- Node SDK `MediaRuntime`, `jobs.create`, `jobs.list`, `jobs.get`, and `Job.wait`.
- Node SDK `capabilities.retrieve()` and its ordered `publicPresets` catalog.
- Gateway `contracts/v1/openapi.json` and `contracts/v1/conformance.json`.
- Frozen output aliases: `video.web`, `video.streaming`, `video.social`, `audio.web`,
  `audio.transcription`, and `image.web`.
- Single-job terminal states: `COMPLETED`, `FAILED`, and `REJECTED`.
- Batch jobs visible through `jobs` may also end in `PARTIAL`.
- Webhook signing base: `{timestamp}.{event_id}.{exact_raw_body_bytes}` with HMAC-SHA256.
- Bundle access is owner/job scoped and bounded by `retentionDays` / `expiresAt`; expired
  redemption returns HTTP `410`.

Contract drift is handled by upgrading the SDK and its vendored gateway snapshot, not by
adding a second hand-maintained API model to the CLI.

## 4. Configuration and precedence

Authenticated commands resolve configuration once before doing file or network work.

| Setting | Highest precedence | Environment | Default |
|---|---|---|---|
| API key | `MEDIARUNTIME_API_KEY` | OS-vault browser login | required for `run` and `jobs`; not required for capability discovery |
| API base URL | `--base-url <url>` | `MEDIARUNTIME_API_URL` | `https://mediaruntime.com` |
| Webhook signing secret | `--secret-file <path>` | `MEDIARUNTIME_WEBHOOK_SECRET` | required by `trigger`, unless explicitly generated |

There is deliberately no `--api-key` or `--secret` option: command-line arguments are
visible in shell history and process listings. The CLI does not load `.env` files, write
plaintext credentials, or search parent directories for configuration. Browser login is
stored only in the platform credential vault; machines without one use the environment.

`--base-url` exists for a local gateway, staging, and deterministic tests; ordinary users
must not need it. It must be an absolute HTTP(S) origin with no credentials, query, or
fragment. HTTPS is required except for an explicitly loopback host. Trailing slashes are
normalized. The flag is accepted before the command:

```bash
mediaruntime --base-url http://127.0.0.1:8001 jobs list
```

`trigger` neither reads the API key nor uses the base URL.

## 5. Command contract

### 5.1 `run`

```text
mediaruntime run <source>
  (--output <alias> | --preset <public-preset>) [...]
  [--metadata <json-object>]
  [--idempotency-key <key>]
  [--wait]
  [--timeout-ms <positive-integer>]
  [--download <zip-path>] [--force]
  [--json]
```

`-o` is the short spelling of `--output`. Exactly one source and at least one output or preset are
required. `<source>` may be an HTTP(S) URL, `gs://` URI, local path, or `file://` URL. The
CLI passes it to the SDK so local inputs use the SDK's signed-upload flow.

Each `--output` must be one of the six frozen aliases. Each `--preset` must appear in the
gateway's ordered `publicPresets` catalog; the CLI retrieves its output type and submits
the corresponding explicit output object. Repeating and mixing both options preserves
caller order. Custom output objects and batch inputs remain intentionally deferred from
the quick CLI; use an SDK when that control is required.

`--metadata` is one JSON object, for example:

```bash
--metadata '{"asset_id":"asset_42","producer":"local-script"}'
```

It is parsed locally and rejected before submission if malformed, an array, or a scalar.
`--idempotency-key` is the caller's durable business key. If it is omitted, the SDK
creates one invocation-scoped key and reuses it only for that invocation's transport
retries.

Without `--wait`, the command prints the accepted receipt and exits. `--wait` uses the SDK
poller until a terminal state. `--timeout-ms` applies to that wait, defaults to `300000`,
and is invalid without `--wait` or `--download`. `--download` implies `--wait`.

Examples:

```bash
mediaruntime run ./launch.mp4 -o video.web --wait

mediaruntime run ./launch.mp4 \
  -o video.streaming -o audio.transcription \
  --metadata '{"asset_id":"launch-01"}' \
  --idempotency-key 'asset:launch-01:v1' \
  --download ./launch-01.zip

mediaruntime run ./launch.mp4 \
  --preset dash_ladder_v1 --preset webm_vp9_1080p \
  --download ./adaptive-and-vp9.zip

mediaruntime run ./launch.mp4 \
  --recipe team-video@3 \
  --download ./launch.zip
```

### 5.2 Capability and preset discovery

```text
mediaruntime capabilities [--json]
mediaruntime presets list [--json]
```

Both commands call the unauthenticated capability endpoint and therefore do not require
a browser login or `MEDIARUNTIME_API_KEY`. Human output summarizes aliases, optional
features, and the ordered public preset table. JSON uses the Node SDK's camelCase contract;
`presets list --json` returns `{presets: [...]}` in gateway order. Neither command infers
public availability from the broader internal preset map.

### 5.3 Hosted recipes

`recipes list/get/create/version/archive` delegates to the Node SDK recipe resource.
Create and version commands read explicit JSON files; secrets are never accepted in a
recipe or printed. `version --expected` is the optimistic-lock precondition. `run
--recipe` is mutually exclusive with aliases and public presets, and a resolved recipe
uses the same job wait, exit, spinner, and atomic ZIP path as any other job.

### 5.4 `jobs list`

```text
mediaruntime jobs list
  [--status <status>]
  [--limit <1..100>]
  [--cursor <opaque-cursor>]
  [--json]
```

The command retrieves exactly one account-scoped page, newest first. Status is normalized
to uppercase. `--cursor` is opaque and passed back unchanged; the CLI never decodes it.
It does not automatically walk all pages. Human output ends with the next cursor when one
exists. JSON output retains `nextCursor`.

The human table columns are `ID`, `STATUS`, `TIER`, `UNITS`, `BUNDLE`, and `UPDATED`.
List rows intentionally have no bundle download URL; `jobs get` is the download-aware
surface.

### 5.5 `jobs get`

```text
mediaruntime jobs get <job_id>
  [--download <zip-path>] [--force]
  [--json]
```

Exactly one non-empty job ID is required. The gateway returns `404` for both an unknown
job and a job owned by another account; the CLI must not try to distinguish them.

Human output includes ID, status, effective/billed tier, bundle availability and size,
and a terminal error when present. Machine output contains the curated SDK job projection.
Neither format prints the signed bundle URL. `--download` redeems it internally when the
job is `COMPLETED` and the bundle is available.

`jobs get` is a snapshot operation and does not poll. A nonterminal job is reported as it
currently exists. Waiting is provided by `run --wait` in v1.

### 5.4 `trigger`

```text
mediaruntime trigger <event-type> --to <loopback-url>
  [--job-id <job_id>]
  [--account-id <account_id>]
  [--secret-file <path> | --generate-secret]
  [--json]
```

Supported event types match the production Firebase terminal-webhook sender exactly:

| Event argument | Payload status | Timestamp field |
|---|---|---|
| `job.completed` | `COMPLETED` | `completedAt` |
| `job.failed` | `FAILED` | `failedAt` |
| `job.rejected` | `REJECTED` | `rejectedAt` |

`PARTIAL` is a batch polling state but is not currently emitted by the production webhook
sender, so `job.partial` is not a v1 trigger type.

`--to` is mandatory and must be an absolute HTTP(S) URL whose parsed hostname is
`localhost`, an address in `127.0.0.0/8`, or IPv6 loopback `::1`. URL credentials are
rejected. Redirects are not followed, including a redirect to another loopback URL.

The usual secret source is `MEDIARUNTIME_WEBHOOK_SECRET`. `--secret-file` reads a UTF-8
file, trims surrounding whitespace, and overrides the environment. It is mutually
exclusive with `--generate-secret`. A blank value is invalid.

`--generate-secret` is deliberately explicit and development-only. It creates 32 random
bytes with the operating-system CSPRNG and prints their base64url form before sending.
Because the receiver must verify with that exact value, this mode is only useful when a
local test harness can capture the emitted secret and coordinate receiver configuration.
Normal interactive development should configure one secret in both the receiver and
`MEDIARUNTIME_WEBHOOK_SECRET` before running `trigger`. An environment- or file-sourced
secret is never printed. `--generate-secret` and `--json` are mutually exclusive: the
generated value is a human preflight line rather than an ordinary result field.

When IDs are omitted, the command generates a UUID-backed job/event pair and uses
`acc_cli_local`. A generated completion payload contains realistic `delivery`, bounded
retention, billing, usage, and metadata shapes; its bundle URL is loopback-only synthetic
data and is not a real downloadable artifact. Failure and rejection payloads contain a
synthetic `{code,message}` error and no deliverable bundle.

## 6. Webhook signing and delivery

The trigger serializer creates the JSON body once. Those exact bytes are signed and sent;
the body must never be parsed and serialized again between the two operations.

```text
timestamp    = floor(current Unix milliseconds / 1000)
signing_base = utf8("{timestamp}.{event_id}.") || raw_body_bytes
digest       = lowercase_hex(HMAC_SHA256(secret, signing_base))
```

The POST contains:

```text
Content-Type: application/json
X-Transcoder-Id: <event_id>
X-Transcoder-Timestamp: <timestamp>
X-Transcoder-Signature: t=<timestamp>,v1=<digest>
```

The payload `event_id` and the header ID are identical. The request has a 10-second
timeout, uses `redirect: manual`, and succeeds only for HTTP `2xx`. Response bodies are not
echoed because a local receiver may return application secrets or arbitrary HTML.

## 7. Bundle download contract

Both `run --download` and `jobs get --download` call one shared downloader.

1. Obtain the job's current `bundle.downloadUrl` from the authenticated SDK response.
2. Make a fresh `GET` to that exact URL and follow the gateway's expected redirect to
   object storage.
3. Do **not** attach `X-API-Key`, `Authorization`, cookies, webhook headers, or the API base
   URL to this request. The URL's scoped token is the only redemption credential.
4. Stream to a uniquely named temporary file beside the requested destination; never
   buffer the ZIP in memory.
5. If the job supplies `sizeBytes` or `sha256`, validate them while streaming.
6. Close and atomically rename the temporary file only after the response and integrity
   checks succeed.
7. On any failure, close and remove the temporary file. Preserve an existing destination.

The destination is always a ZIP file path, not a directory. Its parent directory must
already exist. The command refuses to overwrite an existing file unless `--force` is
present; even with `--force`, the old file remains intact until the replacement has been
fully downloaded and verified.

An unavailable bundle, missing download URL, expired redemption (`410`), non-`2xx` final
response, truncated stream, size mismatch, SHA-256 mismatch, or filesystem failure is a
download error. The CLI does not silently resubmit the job, extend retention, or fall back
to internal storage URIs. It never extracts the archive.

## 8. Standard streams and output formats

The process contract is designed for composition:

- `stdout` contains successful command data only, except that the explicitly requested
  `--generate-secret` preflight line is emitted before its local POST so a coordinated
  test harness can configure verification.
- `stderr` contains usage errors, configuration errors, API/network errors, request IDs,
  and any human waiting diagnostic.
- The CLI never prompts. It reads no stdin in v1.
- Every emitted record ends with one newline.
- ANSI color is used only when stderr/stdout is a TTY and never in JSON mode.
- Secrets are never written except the explicitly requested generated trigger secret.

### Human format

Human output is concise and may evolve cosmetically. It is not a parsing contract. Job
IDs, statuses, cursors, paths, and HTTP status values remain literal. In an interactive
terminal, `run` renders one elapsed-time spinner on `stderr` while uploading/submitting,
waiting, and downloading/verifying. It clears the line before final output or errors.
The indicator is disabled for `--json` and whenever `stderr` is not a TTY. Waiting output
must not invent percentages; the gateway supplies state, not continuous progress.

### JSON format

`--json` emits exactly one compact JSON object plus a newline on success, with no spinner,
table, ANSI sequence, or explanatory text. Field names use the SDK's camelCase public
surface.

- `run` without waiting: the job receipt (`id`, `status`, `tier`, `requiredTier`,
  `outputs`, `message`).
- `run --wait` and `jobs get`: curated job details, with bundle availability,
  `expiresAt`, `sizeBytes`, `sha256`, and `retentionDays`, but no `downloadUrl`.
- `jobs list`: `{jobs, nextCursor}` from the SDK.
- `capabilities`: the complete SDK capability projection.
- `presets list`: `{presets: [...]}` containing only ordered public preset rows.
- `trigger`: `{eventId, type, jobId, status, destination, httpStatus}`.

If `--download` is used, a successful atomic download is required before exit `0`. The
JSON job projection remains the sole stdout object; the destination is already known from
the command argument. Implementations should delay writing it until download success so a
failed download cannot leave success data on stdout.

In JSON mode, errors are one compact object on `stderr`:

```json
{"error":{"code":"authentication_error","message":"Unauthorized","exitCode":3,"requestId":"req_...","retryable":false}}
```

Optional `requestId`, `retryable`, and sanitized `details` come from
`MediaRuntimeApiError`. Raw response bodies, request bodies, API keys, webhook secrets,
signed URLs, and filesystem temporary names are never included.

## 9. Exit codes

The central entrypoint owns error-to-exit translation; command modules return semantic
results and must not invent conflicting mappings.

| Code | Meaning |
|---:|---|
| `0` | Command succeeded; a waited/inspected job is `COMPLETED` or nonterminal |
| `1` | Unexpected internal CLI error |
| `2` | Command syntax, local validation, or missing configuration |
| `3` | Authentication, billing-required, or permission failure (`401`/`402`/`403`) |
| `4` | Non-retryable API outcome such as `400`, `404`, `409`, `410`, `413`, or `422`, or exhausted `429` |
| `5` | Connection/HTTP timeout or exhausted retryable `5xx` response |
| `6` | A submitted or inspected job is terminal `FAILED`, `REJECTED`, or `PARTIAL` |
| `7` | Job waiting or browser authorization exceeded its bounded timeout |
| `8` | Local trigger endpoint returned a redirect or non-`2xx` response |
| `9` | Bundle availability, redemption, integrity, or filesystem failure |
| `130` | Interrupted by `SIGINT`; in-flight fetch/poll/download is aborted and temporary files are removed |

`jobs list` returns `0` for an empty page. `jobs get` returns `0` for queued/processing or
completed jobs and `6` for unsuccessful terminal states after still printing the job.
`run` without waiting returns `0` for an accepted nonterminal/completed receipt and `6`
for an immediate unsuccessful terminal receipt. `run --wait` returns `6` after printing
the final failed/rejected/partial job. Trigger connection failure is `5`; a reached local
endpoint that refuses the event is `8`.

## 10. Security rules

- Never accept API keys or webhook secrets as ordinary command arguments.
- Persist browser-login credentials only in the operating-system credential vault; never
  fall back to a plaintext file.
- Redact credentials and signed query strings from errors and debug output.
- Treat JSON output containing metadata as caller-sensitive even though signed bundle URLs
  are deliberately omitted.
- Delegate local upload URL creation and API retries to the SDK.
- Validate local source existence/readability before requesting an upload where practical;
  do not follow local symlinks for any purpose other than normal file opening.
- Trigger only literal loopback destinations, forbid URL credentials, and do not follow
  redirects. Its API key environment is irrelevant.
- Sign the exact bytes sent, compare/verify only through SDK helpers in receiver examples,
  and never describe a parsed-and-reserialized JSON body as safe to verify.
- Bundle redirects are the one intentional cross-origin redirect flow. Never forward API
  authentication headers to the redirected host.
- Use bounded memory for uploads/downloads and cap locally generated webhook payloads.
- Preserve the account-scoped `404` ambiguity; do not reveal whether another account owns
  a requested job.

## 11. Architecture boundaries

Recommended modules are deliberately narrow:

```text
src/cli.ts                 argv dispatch, configuration, signals, exit/error rendering
src/commands/run.ts        run parsing and SDK orchestration
src/commands/jobs.ts       list/get parsing and projections
src/commands/trigger.ts    local event orchestration
src/commands/auth.ts       login/status/logout orchestration and precedence
src/auth/api.ts            one-time browser authorization protocol
src/auth/credential-store.ts OS credential-vault boundary
src/auth/browser.ts        shell-free browser launcher
src/download.ts            streamed atomic bundle redemption
src/trigger/event.ts       synthetic public payloads
src/trigger/signature.ts   byte signing and headers
src/trigger/destination.ts loopback-only URL validation
```

All command functions accept injected SDK clients, fetch, clocks, UUID/random sources,
filesystem operations, and output writers as appropriate. Unit tests must not require
production credentials, billable jobs, real storage, or listening ports.

## 12. Acceptance tests

### Parsing and configuration

- Every documented command/flag combination parses; unknown flags and extra positionals
  exit `2` before network access.
- Missing/blank environment key falls back to the OS-vault login; when both are absent,
  `run` and `jobs` fail while `trigger` remains independent.
- `--base-url` overrides the environment, which overrides production; invalid or insecure
  non-loopback HTTP URLs fail closed.
- No command accepts `--api-key`, `--secret`, a per-job webhook URL, or `listen`.

### Browser authentication

- `login` sends only a PKCE challenge, opens the returned MediaRuntime authorization URL,
  polls at the server-provided interval, and never prints the issued API key.
- Approval requires the existing verified Firebase identity, active owner/admin account
  membership, active billing, available funds, and an explicit matching-code consent.
- The browser and Firestore never receive the raw CLI API key or PKCE verifier.
- A successful exchange creates exactly one dedicated CLI key across concurrent polls and
  lost responses, then stores it only in the OS credential vault.
- `auth status` reports source/account/key metadata without secret material.
- `logout` revokes the dedicated key before deleting it; `--local-only` is explicit.
- `MEDIARUNTIME_API_KEY` takes precedence and remains supported for automation.

### Run

- Each of the six aliases is accepted, forwarded unchanged, and covered by a fixture;
  unknown aliases are rejected locally.
- HTTP(S), `gs://`, local path, and `file://` sources use the SDK path, including signed
  upload for local files.
- Metadata must be an object; output order and a supplied idempotency key are preserved.
- No-wait prints a receipt once. Wait recognizes all SDK terminal states, maps unsuccessful
  status to `6`, and maps `JobWaitTimeoutError` to `7`.
- `--download` implies wait and does not print success before the atomic download finishes.

### Jobs

- List forwards uppercase status, validates limit `1..100`, preserves the opaque cursor,
  and displays/serializes the next cursor.
- Get percent-encodes the ID through the SDK, does not expose a signed URL, preserves the
  account-scoped `404`, and maps unsuccessful terminal state to `6`.

### Bundle download

- Gateway `307` followed by storage `200` succeeds without forwarding API credentials.
- Existing destination refusal, `--force` atomic replacement, expired `410`, interrupted
  stream, HTTP failure, SHA mismatch, size mismatch, write failure, and `SIGINT` cleanup
  are covered.
- Tests assert the ZIP bytes are not extracted or interpreted.

### Trigger

- All three production event types create the correct status/timestamp/error-or-delivery
  shape; unsupported and `job.partial` fail locally.
- Fixed clock, UUID, payload, and secret fixtures reproduce the exact expected HMAC.
- The body bytes used for HMAC are byte-identical to the POST body.
- Environment, trimmed secret-file, missing secret, blank file, mutually exclusive secret
  modes, and CSPRNG-generated secret paths are covered without logging non-generated
  secrets.
- `localhost`, `127.0.0.0/8`, and IPv6 loopback pass; public/private non-loopback hosts,
  URL credentials, unsupported schemes, and every redirect fail closed.
- A `2xx` response exits `0`; local non-`2xx` exits `8`; connection/timeout exits `5`.

### Process I/O

- Every JSON success/error path parses as exactly one object on the documented stream and
  contains no ANSI bytes.
- Human errors include a gateway request ID when available.
- stdout stays empty on pre-execution and download errors; stderr never contains an API
  key, webhook secret, or signed bundle URL.
- `SIGINT` aborts active work and exits `130` without a stack trace.

## 13. Release gates

The v1 release gates are:

1. Type checking, unit tests, package smoke tests, and Node 22/24 CI pass.
2. A packed tarball installs and exposes the `mediaruntime` executable with a valid
   shebang and no development fixtures.
3. Contract tests use the released Node SDK's gateway fixtures for aliases and statuses.
4. A local-file `run --wait --download` smoke test succeeds against a non-production test
   account and produces a valid ZIP.
5. A local receiver using `@mediaruntime/node` verification accepts every trigger type and
   rejects a changed body, stale timestamp, and wrong secret.
6. Browser login passes a production create/approve/exchange/status/logout smoke test;
   documentation labels only `listen` as deferred.
