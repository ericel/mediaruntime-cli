# Hosted Sticker Runtime CLI contract

## Authentication boundary

Sticker commands use the normal trusted credential by default: an explicit
`MEDIARUNTIME_API_KEY`, then the API key stored by `mediaruntime login`. There is no
command-line secret flag.

`MEDIARUNTIME_STICKER_CLIENT_TOKEN` is an optional short-lived credential for only these
collection-bound runtime reads:

```text
stickers packs list
stickers search
stickers typeahead
stickers get
stickers resolve
```

When this variable is set for one of those reads, the CLI constructs the Node SDK's scoped
`StickerRuntime` directly and does not resolve or send a master API key. The explicit
`--collection` must match the token claim. A scoped token cannot manage collections or pack
bindings, inspect workspace usage, or mint another token. Those commands always require the
trusted credential.

## Collection management

```text
mediaruntime stickers collections list [--include-archived] [--json]
mediaruntime stickers collections create --name <name> [--description <text>] [--json]
mediaruntime stickers collections get <collection_id> [--json]
mediaruntime stickers collections update <collection_id>
  [--name <name>] [--description <text> | --clear-description]
  [--status active|archived] [--json]
mediaruntime stickers collections archive <collection_id> [--json]
```

Archive is recoverable and retains pack-binding history. Restore an archived collection with
`collections update <collection_id> --status active`. JSON output is the SDK's camel-case
projection.

## Pack bindings

```text
mediaruntime stickers collections packs list <collection_id> [--json]
mediaruntime stickers collections packs enable <collection_id>
  (--pack <pack_id> | --activation <activation_id>) [--json]
mediaruntime stickers collections packs disable <collection_id> --pack <pack_id> [--json]
```

These commands bind an existing paid Hosted Pack activation to an application collection.
They do not purchase, activate, revoke, or charge for a pack. The stable pack-ID form is
idempotent and suitable for configuration scripts. The activation-ID form is useful just
after an account administrator completes activation elsewhere.

Disabling removes the pack from new-use discovery while retaining the binding and its
historical-access policy. Exact historical references can therefore remain renderable when
the policy is `preserve`; search and metadata retrieval no longer return the disabled pack.

## Runtime reads

```text
mediaruntime stickers packs list --collection <collection_id> [--json]
mediaruntime stickers search <query> --collection <collection_id>
  [--pack <pack_id>] [--category <category>]
  [--animated | --static] [--limit <1..50>] [--json]
mediaruntime stickers typeahead <prefix> --collection <collection_id>
  [--pack <pack_id>] [--locale <locale>] [--limit <1..20>] [--json]
mediaruntime stickers get <sticker_id> --collection <collection_id> [--json]
mediaruntime stickers resolve <sticker_id> --variant <variant>
  --collection <collection_id> [--json]
```

Search is metadata-only. Persist the stable `stickerId`, then call `resolve` only when an
approved representation is needed. Resolution intentionally prints the short-lived signed
URL because delivery authorization is the command's purpose. The URL is collection checked,
variant checked, generation pinned, and expiring; do not persist it or write it to logs.

Supported variants are `animated`, `reduced_motion`, `small_80`, `small_100`, `small_160`,
and `thumbnail`. The gateway remains authoritative and may reject a supported name when the
specific sticker does not publish that representation.

## Usage and scoped token issuance

```text
mediaruntime stickers usage [--json]
mediaruntime stickers token create --collection <collection_id>
  [--expires-in <60..3600>]
  [--scope packs:read|stickers:search|stickers:read|assets:resolve]...
  [--json]
```

Omitting `--scope` asks the gateway for all four read scopes. Repeated scopes are
deduplicated. Token output is secret-bearing by explicit request; redirect it only to a
protected sink and avoid CI log capture. Usage is pooled at workspace/month level and
reports operations, authorized delivery bytes, included allowances, settled overage, and
health status. URL issuance records maximum authorized bytes; it does not claim that the
client completed a CDN transfer.
