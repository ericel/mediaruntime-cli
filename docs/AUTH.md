# CLI browser authentication

## Outcome

`mediaruntime login` authenticates an interactive developer through the existing
MediaRuntime website and stores a dedicated, revocable CLI API key in the operating
system credential vault. `MEDIARUNTIME_API_KEY` remains permanently supported and takes
precedence over a stored login for CI, servers, containers, and intentional per-command
account selection.

The browser flow does not change gateway authentication. Once authorized, the CLI uses
the same `X-API-Key` data-plane contract as every other API-key client.

## Protocol

1. The CLI generates a PKCE verifier and sends only its SHA-256 challenge to
   `POST /api/cli/auth/start`.
2. Functions returns a signed, ten-minute stateless device request, a short display
   code, a polling interval, and
   `https://mediaruntime.com/cli/authorize?...`.
3. The CLI opens that URL and also prints the URL and display code for headless use.
4. The website uses the existing Firebase login. It shows the code and selected account,
   and requires an explicit Approve action.
5. The browser sends its Firebase ID token to `POST /api/cli/auth/approve`. Functions
   verifies the signed device request and re-checks identity, active owner/admin
   membership, account state, billing, and wallet access before persisting an approved
   authorization session.
6. The CLI polls `POST /api/cli/auth/token` with the device code and PKCE verifier.
   Functions verifies both, creates one dedicated API key, and returns that key only to
   the CLI. The browser never receives it and Firestore never stores it in plaintext.
7. The CLI validates the credential and stores it in the platform credential vault.

Pending, denied, expired, consumed, and slow polling states use stable machine-readable
error codes. Authorization sessions expire after ten minutes. Successful exchange is
single-use; a short deterministic replay window makes a lost token response recoverable
without creating another key.

## Commands

```text
mediaruntime login [--no-browser]
mediaruntime auth status
mediaruntime logout [--local-only]
```

`login` refuses `--json` because it is interactive. It never prints the API key.
`auth status` identifies the active credential source (`environment` or `keychain`) and
validates it without displaying secret material. `logout` revokes the stored CLI key
before deleting it; `--local-only` is an explicit recovery path when the service cannot
be reached.

## Credential resolution

Authenticated commands resolve credentials in this order:

1. non-empty `MEDIARUNTIME_API_KEY`;
2. an OS-vault credential stored by `mediaruntime login`;
3. an authentication-required error that recommends `mediaruntime login` or the
   environment variable.

No command-line API-key flag exists. No plaintext credential-file fallback exists. A
machine without a supported credential vault must use `MEDIARUNTIME_API_KEY`.

## Security invariants

- Device codes and PKCE verifiers carry at least 256 bits of randomness.
- Starting login is stateless and performs no database write. After browser approval,
  Firestore stores the device-code hash, PKCE challenge, approval metadata, and key
  identifiers, never the raw device code, API key, or PKCE verifier.
- Display codes are bound to the device session and expire after ten minutes.
- Approval requires a fresh verified Firebase identity and active owner/admin account
  membership.
- A session cannot change accounts after approval.
- A token exchange cannot mint more than one API key.
- CLI keys are separately labeled and revocable; login never revokes unrelated keys.
- Logout revokes only the key created for that stored CLI login.
- Secrets are excluded from logs, JSON output, URLs, errors, analytics, and shell history.
- Production uses HTTPS. Development overrides may use loopback HTTP only.

## Deployment and compatibility

The hosted approval route and Functions endpoints must deploy before publishing the CLI
version that exposes `login`. Older CLI versions and all SDKs continue to use
`MEDIARUNTIME_API_KEY` unchanged. If browser authorization is unavailable, automation and
interactive users can still use the environment variable.
