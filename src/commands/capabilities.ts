import type { Capabilities } from "@mediaruntime/node";
import { UsageError } from "../errors.js";

export interface CapabilitiesReadClient {
  retrieve(): Promise<Capabilities>;
}

export interface CapabilitiesCommandDependencies {
  capabilities: CapabilitiesReadClient;
  writeStdout(text: string): void;
}

export interface PublicPresetRow {
  name: string;
  outputType: string;
  tier: string;
  sourceKinds: string[];
  artifacts: string[];
  description: string;
  codec: string | null;
  container: string | null;
}

function cell(value: string): string {
  return value || "-";
}

function table(headings: string[], rows: string[][]): string {
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (row: string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd();
  return `${[
    render(headings),
    render(widths.map((width) => "-".repeat(width))),
    ...rows.map(render),
  ].join("\n")}\n`;
}

export function publicPresetRows(capabilities: Capabilities): PublicPresetRow[] {
  return capabilities.publicPresets.map((name) => {
    const preset = capabilities.presets[name];
    if (!preset) {
      throw new Error(`Gateway capability contract is missing public preset metadata for ${name}`);
    }
    return {
      name,
      outputType: preset.outputType,
      tier: preset.baseTier,
      sourceKinds: preset.sourceKinds,
      artifacts: preset.artifacts,
      description: preset.description,
      codec: preset.codec ?? null,
      container: preset.container ?? null,
    };
  });
}

function parseJsonOnly(args: string[], command: string): boolean {
  let json = false;
  for (const argument of args) {
    if (argument === "--json") json = true;
    else throw new UsageError(`Unknown ${command} option: ${argument}`);
  }
  return json;
}

export async function runCapabilitiesCommand(
  args: string[],
  dependencies: CapabilitiesCommandDependencies,
): Promise<number> {
  const json = parseJsonOnly(args, "capabilities");
  const capabilities = await dependencies.capabilities.retrieve();
  if (json) {
    dependencies.writeStdout(`${JSON.stringify(capabilities)}\n`);
    return 0;
  }

  const aliases = Object.entries(capabilities.outputAliases).map(([name, value]) => [
    name,
    value.type,
    value.preset,
    value.tier,
  ]);
  dependencies.writeStdout(
    `Public presets: ${capabilities.publicPresets.length}\n` +
      `Optional features: ${Object.keys(capabilities.features).sort().join(", ") || "none"}\n\n` +
      table(["ALIAS", "TYPE", "PRESET", "TIER"], aliases) +
      "\nRun `mediaruntime presets list` for the complete public preset catalog.\n",
  );
  return 0;
}

export async function runPresetsCommand(
  args: string[],
  dependencies: CapabilitiesCommandDependencies,
): Promise<number> {
  const subcommand = args[0];
  if (subcommand !== "list") throw new UsageError("Usage: mediaruntime presets list [--json]");
  const json = parseJsonOnly(args.slice(1), "presets list");
  const capabilities = await dependencies.capabilities.retrieve();
  const presets = publicPresetRows(capabilities);
  if (json) dependencies.writeStdout(`${JSON.stringify({ presets })}\n`);
  else {
    dependencies.writeStdout(table(
      ["PRESET", "TYPE", "TIER", "INPUTS", "ARTIFACTS"],
      presets.map((preset) => [
        preset.name,
        cell(preset.outputType),
        cell(preset.tier),
        preset.sourceKinds.join(","),
        preset.artifacts.join(", "),
      ]),
    ));
  }
  return 0;
}
