# MediaRuntime CLI

Official command-line client for MediaRuntime. It submits media, waits for jobs, downloads
the canonical ZIP output bundle, inspects account jobs, and sends correctly signed
synthetic webhooks to a local receiver.

## Install

```bash
npm install --global @mediaruntime/cli
mediaruntime --version
```

Node.js 20 or newer is required. Authenticated commands read the API key from the
environment; the hosted API URL is built in.

```bash
export MEDIARUNTIME_API_KEY="sk_..."
```

Do not pass credentials as command-line arguments. `--base-url` and
`MEDIARUNTIME_API_URL` are development/staging overrides, not normal client setup.

## Run a job

```bash
mediaruntime run ./launch.mp4 --output video.web --wait

mediaruntime run ./launch.mp4 \
  --output video.streaming \
  --output audio.transcription \
  --metadata '{"asset_id":"launch-01"}' \
  --idempotency-key 'asset:launch-01:v1' \
  --download ./launch-01.zip
```

`--download` implies `--wait`. The CLI streams the complete MediaRuntime ZIP bundle to a
temporary file, validates its advertised size and SHA-256 when available, and publishes
it atomically. Existing files are preserved unless `--force` is explicit. Signed download
URLs are never printed.

Supported frozen output aliases:

- `video.web`
- `video.streaming`
- `video.social`
- `audio.web`
- `audio.transcription`
- `image.web`

Use `--json` for one compact, URL-redacted machine-readable result. A caller-provided
`--idempotency-key` remains the durable deduplication mechanism across process restarts;
the SDK-generated invocation key only protects retries inside one live command.

## Inspect jobs

```bash
mediaruntime jobs list --limit 20
mediaruntime jobs list --status COMPLETED --json
mediaruntime jobs get job_123
mediaruntime jobs get job_123 --download ./job_123.zip
```

Listing reads one page and prints an opaque next cursor when another page exists. Pass it
back with `--cursor`; the CLI does not decode or automatically walk pagination.

## Test a local webhook receiver

Use the same webhook secret configured in the local application:

```bash
export MEDIARUNTIME_WEBHOOK_SECRET="whsec_..."

mediaruntime trigger job.completed \
  --to http://127.0.0.1:3000/webhooks/mediaruntime
```

`trigger` supports `job.completed`, `job.failed`, and `job.rejected`. It signs the exact
JSON bytes with the production `X-Transcoder-*` HMAC protocol and sends them directly to
an explicit loopback URL. It does not call the MediaRuntime API, create a tunnel, register
a webhook, or follow redirects. `--secret-file` avoids environment configuration;
`--generate-secret` is an explicit local-harness mode and prints only the newly generated
secret.

See [the trigger security notes](docs/TRIGGER.md) for the complete local-delivery contract.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Command succeeded |
| `1` | Unexpected CLI error |
| `2` | Invalid arguments or missing configuration |
| `3` | Authentication, billing, or permission failure |
| `4` | Non-retryable API result or exhausted throttling |
| `5` | Connection, timeout, or exhausted server failure |
| `6` | Job ended as `FAILED`, `REJECTED`, or `PARTIAL` |
| `7` | Job wait timed out |
| `8` | Local trigger endpoint rejected the event |
| `9` | Bundle availability, integrity, redemption, or filesystem failure |
| `130` | Interrupted with `SIGINT` |

The full implementation contract is in [docs/CLI_SDD.md](docs/CLI_SDD.md).

## Scope

The first release intentionally does not implement `listen`, `login`, credential storage,
or a webhook relay. Production completion continues to use the account destination under
Account → Webhooks. The ZIP remains the canonical completed-job result.
