# Local webhook trigger

`mediaruntime trigger` sends one synthetic, correctly signed terminal webhook directly
from the CLI process to a local HTTP endpoint. It does not call the MediaRuntime API, open
a tunnel, register a webhook, or use a relay.

```bash
export MEDIARUNTIME_WEBHOOK_SECRET='whsec_...'

mediaruntime trigger job.completed \
  --to http://127.0.0.1:3000/webhooks/mediaruntime
```

Supported event types are `job.completed`, `job.failed`, and `job.rejected`. The body uses
the corresponding uppercase terminal status. `--job-id` and `--account-id` replace the
synthetic identifiers when application routing needs known values.

The CLI serializes the JSON body once, signs those exact bytes with HMAC-SHA256, and sends:

- `X-Transcoder-Id`
- `X-Transcoder-Timestamp`
- `X-Transcoder-Signature: t=<timestamp>,v1=<hex digest>`

The normal secret source is `MEDIARUNTIME_WEBHOOK_SECRET`, matching the official SDK
verification helpers. `--secret-file /path/to/secret` avoids exposing a secret in shell
history or the process list; restrict that file to the current user. There is deliberately
no `--secret` argument.

`--generate-secret` is an explicit development-only mode. It securely generates and
prints a one-time secret before sending; the local receiver must be configured with that
exact value to verify the request. The CLI never prints an environment- or file-sourced
secret.

For safety, `--to` is required and accepts only `http://` or `https://` loopback URLs:
`localhost`, `127.0.0.0/8`, or `::1`. URL credentials and redirects are rejected/not
followed, preventing the signed body from being forwarded to another host. Use a real
gateway webhook for any non-local integration test.

The command exits `0` only after a `2xx` response. Invalid arguments, missing secrets,
connection/time-out failures, redirects, and non-`2xx` responses are errors handled by the
CLI entrypoint as a nonzero exit. No API credential is required or read by this command.
