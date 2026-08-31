import { UsageError } from "../errors.js";

// Keep the command layer structurally typed so it remains a thin adapter over the
// SDK while tests can supply small clients without constructing an HTTP transport.
export interface StickerCollectionRecord {
  collectionId: string;
  name: string;
  description: string;
  status: "active" | "archived";
  packs: StickerPackBinding[];
  createdAt: string;
  archivedAt: string | null;
  updatedAt: string;
}

export interface StickerPackBinding {
  bindingId: string;
  collectionId: string;
  activationId: string;
  packId: string;
  packName: string;
  packVersion: string;
  status: "enabled" | "disabled";
  historicalAccess: "preserve" | "revoke";
  updatedAt: string | null;
}

export interface RuntimeStickerRecord {
  stickerId: string;
  packId: string;
  label: string;
  emoji: string | null;
  category: string | null;
  animated: boolean;
  variants: Array<{ name: string; bytes: number }>;
  score?: number;
}

export interface RuntimeStickerPackRecord {
  packId: string;
  name: string;
  version: string;
  assetCount: number;
  animated: boolean;
}

export interface StickerRuntimeReadClient {
  listPacks(): Promise<RuntimeStickerPackRecord[]>;
  search(query: string, options?: {
    packId?: string;
    category?: string;
    animated?: boolean;
    limit?: number;
  }): Promise<{ query: string; items: RuntimeStickerRecord[]; total: number }>;
  typeahead(query: string, options?: {
    packId?: string;
    locale?: string;
    limit?: number;
  }): Promise<{ query: string; locale: string; suggestions: Array<{ text: string; assetCount: number }> }>;
  retrieve(stickerId: string): Promise<RuntimeStickerRecord>;
  resolve(stickerId: string, variant: string): Promise<Record<string, unknown>>;
}

export interface HostedStickersCommandClient {
  listCollections(options?: { includeArchived?: boolean }): Promise<{ items: StickerCollectionRecord[]; total: number }>;
  createCollection(params: { name: string; description?: string | null }): Promise<StickerCollectionRecord>;
  getCollection(collectionId: string): Promise<StickerCollectionRecord>;
  updateCollection(
    collectionId: string,
    params: { name?: string; description?: string | null; status?: "active" | "archived" },
  ): Promise<StickerCollectionRecord>;
  archiveCollection(collectionId: string): Promise<StickerCollectionRecord>;
  listCollectionPacks(collectionId: string): Promise<{ items: StickerPackBinding[]; total: number }>;
  addCollectionPack(collectionId: string, params: { activationId: string }): Promise<StickerPackBinding>;
  enableCollectionPack(collectionId: string, packId: string): Promise<StickerPackBinding>;
  disableCollectionPack(collectionId: string, packId: string): Promise<StickerPackBinding>;
  collection(collectionId: string): StickerRuntimeReadClient;
  usage(): Promise<Record<string, unknown>>;
  createClientToken(params: {
    collectionId: string;
    expiresInSeconds?: number;
    scopes?: string[];
  }): Promise<Record<string, unknown>>;
}

export interface StickersCommandDependencies {
  hosted?: HostedStickersCommandClient;
  runtime?(collectionId: string): StickerRuntimeReadClient;
  writeStdout(text: string): void;
}

const COLLECTION_PATTERN = /^stc_[0-9a-f]{32}$/;
const TOKEN_SCOPES = new Set(["packs:read", "stickers:search", "stickers:read", "assets:resolve"]);
const STICKER_VARIANTS = new Set([
  "animated",
  "reduced_motion",
  "small_80",
  "small_100",
  "small_160",
  "thumbnail",
]);

// Keep the complete subtree discoverable without requiring a credential or network request.
export const STICKERS_HELP = `MediaRuntime Hosted Sticker Runtime

Usage:
  mediaruntime stickers collections list [--include-archived] [--json]
  mediaruntime stickers collections create --name <name> [--description <text>] [--json]
  mediaruntime stickers collections get <collection_id> [--json]
  mediaruntime stickers collections update <collection_id>
    [--name <name>] [--description <text> | --clear-description]
    [--status active|archived] [--json]
  mediaruntime stickers collections archive <collection_id> [--json]
  mediaruntime stickers collections packs list <collection_id> [--json]
  mediaruntime stickers collections packs enable <collection_id>
    (--pack <pack_id> | --activation <activation_id>) [--json]
  mediaruntime stickers collections packs disable <collection_id> --pack <pack_id> [--json]
  mediaruntime stickers packs list --collection <collection_id> [--json]
  mediaruntime stickers search <query> --collection <collection_id>
    [--pack <pack_id>] [--category <category>] [--animated | --static]
    [--limit <1..50>] [--json]
  mediaruntime stickers typeahead <prefix> --collection <collection_id>
    [--pack <pack_id>] [--locale <locale>] [--limit <1..20>] [--json]
  mediaruntime stickers get <sticker_id> --collection <collection_id> [--json]
  mediaruntime stickers resolve <sticker_id> --variant <name>
    --collection <collection_id> [--json]
  mediaruntime stickers usage [--json]
  mediaruntime stickers token create --collection <collection_id>
    [--expires-in <60..3600>] [--scope <scope>]... [--json]

Authentication:
  API key or secure browser login is the default and is required for management,
  pack binding, usage, and token issuance. MEDIARUNTIME_STICKER_CLIENT_TOKEN is
  accepted only for packs/search/typeahead/get/resolve runtime reads and must match
  the explicit --collection. Secrets are never accepted as command-line options.
`;

function optionValue(args: string[], index: number, option: string): string {
  // Reject a following option so misspelled or incomplete commands fail before an SDK call.
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
}

function collectionId(value: string | undefined): string {
  // Collection IDs are path-bearing input, so validate the complete server-issued grammar locally.
  if (!value || !COLLECTION_PATTERN.test(value)) {
    throw new UsageError("--collection must be a MediaRuntime sticker collection ID");
  }
  return value;
}

function boundedInteger(raw: string, option: string, minimum: number, maximum: number): number {
  // Numeric bounds mirror the gateway contract and avoid surprising server-side coercion.
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new UsageError(`${option} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function output(value: unknown, json: boolean, writeStdout: (text: string) => void, human: string): void {
  // JSON stays compact for shell pipelines; human renderers provide a stable concise summary.
  writeStdout(json ? `${JSON.stringify(value)}\n` : human);
}

function table(headings: string[], rows: string[][]): string {
  // Derive widths from actual cells so human output remains readable without terminal dependencies.
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0))
  );
  const render = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd();
  return `${[render(headings), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)].join("\n")}\n`;
}

function collectionTable(page: { items: StickerCollectionRecord[]; total: number }): string {
  // The list view emphasizes lifecycle and enabled-pack count rather than private workspace data.
  return table(
    ["ID", "NAME", "STATUS", "PACKS", "UPDATED"],
    page.items.map((item) => [
      item.collectionId,
      item.name,
      item.status,
      String(item.packs.length),
      item.updatedAt,
    ]),
  );
}

function bindingTable(page: { items: StickerPackBinding[]; total: number }): string {
  // Retained disabled bindings are visible here because this is an audit-oriented management view.
  return table(
    ["PACK", "NAME", "VERSION", "STATUS", "HISTORICAL", "ACTIVATION"],
    page.items.map((item) => [
      item.packId,
      item.packName,
      item.packVersion,
      item.status,
      item.historicalAccess,
      item.activationId,
    ]),
  );
}

function runtimePackTable(items: RuntimeStickerPackRecord[]): string {
  // Runtime pack discovery shows only packs currently eligible for new sticker use.
  return table(
    ["PACK", "NAME", "VERSION", "STICKERS", "ANIMATED"],
    items.map((item) => [
      item.packId,
      item.name,
      item.version,
      String(item.assetCount),
      item.animated ? "yes" : "no",
    ]),
  );
}

function stickerTable(items: RuntimeStickerRecord[]): string {
  // Search output keeps stable IDs prominent so callers can persist an exact reference.
  return table(
    ["STICKER", "LABEL", "EMOJI", "CATEGORY", "ANIMATED", "VARIANTS"],
    items.map((item) => [
      item.stickerId,
      item.label,
      item.emoji ?? "-",
      item.category ?? "-",
      item.animated ? "yes" : "no",
      item.variants.map((variant) => variant.name).join(","),
    ]),
  );
}

function hostedClient(dependencies: StickersCommandDependencies): HostedStickersCommandClient {
  // Management, usage, and token issuance require the trusted API-key-backed SDK client.
  if (!dependencies.hosted) {
    throw new UsageError("This stickers command requires MEDIARUNTIME_API_KEY or mediaruntime login");
  }
  return dependencies.hosted;
}

function runtimeClient(
  selectedCollectionId: string,
  dependencies: StickersCommandDependencies,
): StickerRuntimeReadClient {
  // A scoped token client overrides the server client only for collection-bound read operations.
  if (dependencies.runtime) return dependencies.runtime(selectedCollectionId);
  return hostedClient(dependencies).collection(selectedCollectionId);
}

async function collectionsCommand(
  args: string[],
  dependencies: StickersCommandDependencies,
): Promise<number> {
  // Collection configuration remains under a dedicated subtree to distinguish it from runtime reads.
  const subcommand = args[0];
  const rest = args.slice(1);
  const client = hostedClient(dependencies);
  const json = rest.includes("--json");

  if (subcommand === "list") {
    let includeArchived = false;
    for (const argument of rest) {
      if (argument === "--include-archived") includeArchived = true;
      else if (argument !== "--json") throw new UsageError(`Unknown stickers collections list option: ${argument}`);
    }
    const page = await client.listCollections({ includeArchived });
    output(page, json, dependencies.writeStdout, collectionTable(page));
    return 0;
  }

  if (subcommand === "create") {
    let name: string | undefined;
    let description: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index];
      if (argument === "--name") {
        name = optionValue(rest, index, argument);
        index += 1;
      } else if (argument === "--description") {
        description = optionValue(rest, index, argument);
        index += 1;
      } else if (argument !== "--json") throw new UsageError(`Unknown stickers collections create option: ${argument}`);
    }
    if (!name) throw new UsageError("Usage: mediaruntime stickers collections create --name <name> [--description <text>]");
    const created = await client.createCollection({ name, ...(description === undefined ? {} : { description }) });
    output(created, json, dependencies.writeStdout, `Created sticker collection ${created.collectionId} (${created.name})\n`);
    return 0;
  }

  if (subcommand === "get" || subcommand === "archive") {
    const positional = rest.filter((argument) => argument !== "--json");
    if (positional.length !== 1) {
      throw new UsageError(`Usage: mediaruntime stickers collections ${subcommand} <collection_id>`);
    }
    const selected = collectionId(positional[0]);
    const result = subcommand === "get"
      ? await client.getCollection(selected)
      : await client.archiveCollection(selected);
    const human = subcommand === "get"
      ? `${result.name} (${result.collectionId})\nStatus: ${result.status}\nDescription: ${result.description || "-"}\nEnabled packs: ${result.packs.length}\n`
      : `Archived sticker collection ${result.collectionId}\n`;
    output(result, json, dependencies.writeStdout, human);
    return 0;
  }

  if (subcommand === "update") {
    let selected: string | undefined;
    let name: string | undefined;
    let description: string | null | undefined;
    let status: "active" | "archived" | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index];
      if (argument === "--name") {
        name = optionValue(rest, index, argument);
        index += 1;
      } else if (argument === "--description") {
        description = optionValue(rest, index, argument);
        index += 1;
      } else if (argument === "--clear-description") {
        description = null;
      } else if (argument === "--status") {
        const value = optionValue(rest, index, argument);
        if (value !== "active" && value !== "archived") throw new UsageError("--status must be active or archived");
        status = value;
        index += 1;
      } else if (argument !== "--json" && !selected) selected = argument;
      else if (argument !== "--json") throw new UsageError(`Unknown stickers collections update option: ${argument}`);
    }
    const id = collectionId(selected);
    if (name === undefined && description === undefined && status === undefined) {
      throw new UsageError("stickers collections update requires --name, --description, --clear-description, or --status");
    }
    const updated = await client.updateCollection(id, {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(status === undefined ? {} : { status }),
    });
    output(updated, json, dependencies.writeStdout, `Updated sticker collection ${updated.collectionId}\n`);
    return 0;
  }

  if (subcommand === "packs") return collectionPacksCommand(rest, dependencies);
  throw new UsageError("Usage: mediaruntime stickers collections <list|create|get|update|archive|packs>");
}

async function collectionPacksCommand(
  args: string[],
  dependencies: StickersCommandDependencies,
): Promise<number> {
  // Binding commands never activate or charge a pack; they only attach an existing entitlement.
  const action = args[0];
  const rest = args.slice(1);
  const json = rest.includes("--json");
  const client = hostedClient(dependencies);
  let selected: string | undefined;
  let packId: string | undefined;
  let activationId: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--pack") {
      packId = optionValue(rest, index, argument);
      index += 1;
    } else if (argument === "--activation") {
      activationId = optionValue(rest, index, argument);
      index += 1;
    } else if (argument !== "--json" && !selected) selected = argument;
    else if (argument !== "--json") throw new UsageError(`Unknown stickers collections packs option: ${argument}`);
  }
  const id = collectionId(selected);
  if (action === "list") {
    if (packId || activationId) throw new UsageError("stickers collections packs list does not accept a pack selector");
    const page = await client.listCollectionPacks(id);
    output(page, json, dependencies.writeStdout, bindingTable(page));
    return 0;
  }
  if (action === "enable") {
    if ((packId ? 1 : 0) + (activationId ? 1 : 0) !== 1) {
      throw new UsageError("stickers collections packs enable requires exactly one of --pack or --activation");
    }
    const binding = activationId
      ? await client.addCollectionPack(id, { activationId })
      : await client.enableCollectionPack(id, packId ?? "");
    output(binding, json, dependencies.writeStdout, `Enabled pack ${binding.packId} in ${id}\n`);
    return 0;
  }
  if (action === "disable") {
    if (!packId || activationId) throw new UsageError("stickers collections packs disable requires --pack <pack_id>");
    const binding = await client.disableCollectionPack(id, packId);
    output(binding, json, dependencies.writeStdout, `Disabled pack ${binding.packId} in ${id}; historical references remain ${binding.historicalAccess}\n`);
    return 0;
  }
  throw new UsageError("Usage: mediaruntime stickers collections packs <list|enable|disable> <collection_id>");
}

interface RuntimeOptions {
  collection?: string;
  packId?: string;
  category?: string;
  locale?: string;
  limit?: number;
  animated?: boolean;
  variant?: string;
  json: boolean;
  positional: string[];
}

function parseRuntimeOptions(args: string[], command: string): RuntimeOptions {
  // Runtime commands share collection selection and bounded filters but retain positional query/ID input.
  const options: RuntimeOptions = { json: false, positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--collection") {
      options.collection = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--pack") {
      options.packId = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--category") {
      options.category = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--locale") {
      options.locale = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--limit") {
      const maximum = command === "typeahead" ? 20 : 50;
      options.limit = boundedInteger(optionValue(args, index, argument), argument, 1, maximum);
      index += 1;
    } else if (argument === "--animated" || argument === "--static") {
      if (options.animated !== undefined) throw new UsageError("Use only one of --animated or --static");
      options.animated = argument === "--animated";
    } else if (argument === "--variant") {
      options.variant = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--json") options.json = true;
    else if (argument?.startsWith("--")) throw new UsageError(`Unknown stickers ${command} option: ${argument}`);
    else options.positional.push(argument ?? "");
  }
  return options;
}

async function runtimeCommand(
  command: string,
  args: string[],
  dependencies: StickersCommandDependencies,
): Promise<number> {
  // All runtime reads are collection-bound whether authentication uses an API key or client token.
  const options = parseRuntimeOptions(args, command);
  const id = collectionId(options.collection);
  const client = runtimeClient(id, dependencies);
  if (command === "packs") {
    if (options.packId || options.category || options.locale || options.limit !== undefined ||
        options.animated !== undefined || options.variant) {
      throw new UsageError("stickers packs list accepts only --collection and --json");
    }
    if (options.positional.length !== 1 || options.positional[0] !== "list") {
      throw new UsageError("Usage: mediaruntime stickers packs list --collection <collection_id>");
    }
    const items = await client.listPacks();
    output({ items, total: items.length }, options.json, dependencies.writeStdout, runtimePackTable(items));
    return 0;
  }
  if (command === "search") {
    if (options.locale || options.variant) throw new UsageError("stickers search does not accept typeahead or asset options");
    if (options.positional.length !== 1) throw new UsageError("Usage: mediaruntime stickers search <query> --collection <collection_id>");
    const result = await client.search(options.positional[0] ?? "", {
      ...(options.packId === undefined ? {} : { packId: options.packId }),
      ...(options.category === undefined ? {} : { category: options.category }),
      ...(options.animated === undefined ? {} : { animated: options.animated }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    output(result, options.json, dependencies.writeStdout, stickerTable(result.items));
    return 0;
  }
  if (command === "typeahead") {
    if (options.category || options.animated !== undefined || options.variant) {
      throw new UsageError("stickers typeahead accepts only --pack, --locale, and --limit filters");
    }
    if (options.positional.length !== 1) throw new UsageError("Usage: mediaruntime stickers typeahead <prefix> --collection <collection_id>");
    const result = await client.typeahead(options.positional[0] ?? "", {
      ...(options.packId === undefined ? {} : { packId: options.packId }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const human = table(
      ["SUGGESTION", "STICKERS"],
      result.suggestions.map((suggestion) => [suggestion.text, String(suggestion.assetCount)]),
    );
    output(result, options.json, dependencies.writeStdout, human);
    return 0;
  }
  if (command === "get") {
    if (options.packId || options.category || options.locale || options.limit !== undefined ||
        options.animated !== undefined || options.variant) {
      throw new UsageError("stickers get accepts only --collection and --json");
    }
    if (options.positional.length !== 1) throw new UsageError("Usage: mediaruntime stickers get <sticker_id> --collection <collection_id>");
    const sticker = await client.retrieve(options.positional[0] ?? "");
    const human = `${sticker.label} (${sticker.stickerId})\nPack: ${sticker.packId}\nCategory: ${sticker.category ?? "-"}\nVariants: ${sticker.variants.map((item) => item.name).join(", ")}\n`;
    output(sticker, options.json, dependencies.writeStdout, human);
    return 0;
  }
  if (command === "resolve") {
    if (options.packId || options.category || options.locale || options.limit !== undefined ||
        options.animated !== undefined) {
      throw new UsageError("stickers resolve accepts only --variant, --collection, and --json");
    }
    if (options.positional.length !== 1 || !options.variant) {
      throw new UsageError("Usage: mediaruntime stickers resolve <sticker_id> --variant <name> --collection <collection_id>");
    }
    if (!STICKER_VARIANTS.has(options.variant)) {
      throw new UsageError(`Unsupported sticker variant: ${options.variant}`);
    }
    const resolution = await client.resolve(options.positional[0] ?? "", options.variant);
    // The signed URL is intentionally emitted because asset resolution is this command's explicit purpose.
    const human = `Sticker: ${String(resolution.stickerId ?? "-")}\nVariant: ${String(resolution.variant ?? options.variant)}\nBytes: ${String(resolution.bytes ?? "-")}\nExpires: ${String(resolution.expiresAt ?? "-")}\nURL: ${String(resolution.url ?? "-")}\n`;
    output(resolution, options.json, dependencies.writeStdout, human);
    return 0;
  }
  throw new UsageError("Usage: mediaruntime stickers <packs|search|typeahead|get|resolve>");
}

async function tokenCommand(args: string[], dependencies: StickersCommandDependencies): Promise<number> {
  // Token issuance is deliberately a trusted command; scoped tokens cannot mint descendants.
  if (args[0] !== "create") throw new UsageError("Usage: mediaruntime stickers token create --collection <collection_id>");
  let selected: string | undefined;
  let expiresInSeconds: number | undefined;
  const scopes: string[] = [];
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--collection") {
      selected = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--expires-in") {
      expiresInSeconds = boundedInteger(optionValue(args, index, argument), argument, 60, 3600);
      index += 1;
    } else if (argument === "--scope") {
      const scope = optionValue(args, index, argument);
      if (!TOKEN_SCOPES.has(scope)) throw new UsageError(`Unsupported Sticker Runtime scope: ${scope}`);
      scopes.push(scope);
      index += 1;
    } else if (argument === "--json") json = true;
    else throw new UsageError(`Unknown stickers token create option: ${argument}`);
  }
  const result = await hostedClient(dependencies).createClientToken({
    collectionId: collectionId(selected),
    ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    ...(scopes.length === 0 ? {} : { scopes: [...new Set(scopes)] }),
  });
  // Token output is an explicit secret-bearing response; callers should redirect it to a protected sink.
  const human = `Access token: ${String(result.accessToken ?? "")}\nExpires: ${String(result.expiresAt ?? "-")}\nCollection: ${String(result.collectionId ?? "-")}\nScopes: ${Array.isArray(result.scopes) ? result.scopes.join(", ") : "-"}\n`;
  output(result, json, dependencies.writeStdout, human);
  return 0;
}

export function isScopedStickerRuntimeCommand(args: string[]): boolean {
  // Only read-only, collection-bound operations accept the untrusted client credential.
  return ["packs", "search", "typeahead", "get", "resolve"].includes(args[0] ?? "");
}

export function stickerCollectionOption(args: string[]): string {
  // Extract the collection before client construction so scoped-token mode never needs a master key.
  const index = args.indexOf("--collection");
  return collectionId(index < 0 ? undefined : args[index + 1]);
}

export async function runStickersCommand(
  args: string[],
  dependencies: StickersCommandDependencies,
): Promise<number> {
  // Route one stable top-level namespace to management, runtime, metering, and token operations.
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h")) {
    dependencies.writeStdout(STICKERS_HELP);
    return 0;
  }
  if (command === "collections") return collectionsCommand(args.slice(1), dependencies);
  if (command === "token") return tokenCommand(args.slice(1), dependencies);
  if (command === "usage") {
    const rest = args.slice(1);
    if (rest.some((argument) => argument !== "--json")) throw new UsageError("Usage: mediaruntime stickers usage [--json]");
    const result = await hostedClient(dependencies).usage();
    const human = `Month: ${String(result.month ?? "-")}\nStatus: ${String(result.status ?? "-")}\nOperations: ${String(result.operations ?? 0)} / ${String(result.includedOperations ?? 0)}\nAuthorized delivery: ${String(result.authorizedDeliveryBytes ?? 0)} / ${String(result.includedDeliveryBytes ?? 0)} bytes\nOverage: ${String(result.overageChargedCents ?? 0)} ${String(result.currency ?? "USD")} cents\n`;
    output(result, rest.includes("--json"), dependencies.writeStdout, human);
    return 0;
  }
  if (isScopedStickerRuntimeCommand(args)) return runtimeCommand(command ?? "", args.slice(1), dependencies);
  throw new UsageError("Usage: mediaruntime stickers <collections|packs|search|typeahead|get|resolve|usage|token>");
}
