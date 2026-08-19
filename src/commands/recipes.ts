import { readFile } from "node:fs/promises";
import type {
  CreateRecipeParams,
  CreateRecipeVersionParams,
  HostedRecipe,
} from "@mediaruntime/node";
import { UsageError } from "../errors.js";

export interface RecipesClient {
  list(): Promise<HostedRecipe[]>;
  get(name: string, options?: { version?: number }): Promise<HostedRecipe>;
  create(params: CreateRecipeParams): Promise<HostedRecipe>;
  createVersion(name: string, params: CreateRecipeVersionParams): Promise<HostedRecipe>;
  archive(name: string): Promise<void>;
}

export interface RecipesCommandDependencies {
  recipes: RecipesClient;
  writeStdout(text: string): void;
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageError(`${option} must be a positive integer`);
  }
  return parsed;
}

async function recipeFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new UsageError(`Could not read recipe file: ${path}`, { cause: error });
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new UsageError("Recipe file must contain one JSON object");
  }
}

function humanRecipe(recipe: HostedRecipe): string {
  const kind = recipe.builtIn ? "built-in" : "custom";
  return `${recipe.reference}\n${recipe.description || "No description"}\nType: ${kind}\nStatus: ${recipe.status}\n`;
}

function humanList(recipes: HostedRecipe[]): string {
  const headings = ["REFERENCE", "TYPE", "DESCRIPTION"];
  const rows = recipes.map((recipe) => [
    recipe.reference,
    recipe.builtIn ? "built-in" : "custom",
    recipe.description || "-",
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (row: string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd();
  return `${[render(headings), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)].join("\n")}\n`;
}

function output(recipe: HostedRecipe, json: boolean, write: (text: string) => void): void {
  write(json ? `${JSON.stringify(recipe)}\n` : humanRecipe(recipe));
}

export async function runRecipesCommand(
  args: string[],
  dependencies: RecipesCommandDependencies,
): Promise<number> {
  const subcommand = args[0];
  const rest = args.slice(1);
  const json = rest.includes("--json");

  if (subcommand === "list") {
    if (rest.some((value) => value !== "--json")) throw new UsageError("Usage: mediaruntime recipes list [--json]");
    const recipes = await dependencies.recipes.list();
    dependencies.writeStdout(json ? `${JSON.stringify({ recipes })}\n` : humanList(recipes));
    return 0;
  }

  if (subcommand === "get") {
    let name: string | undefined;
    let version: number | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index];
      if (value === "--version") {
        version = positiveInteger(optionValue(rest, index, value), value);
        index += 1;
      } else if (value !== "--json" && !name) name = value;
      else if (value !== "--json") throw new UsageError("recipes get accepts one name");
    }
    if (!name) throw new UsageError("Usage: mediaruntime recipes get <name> [--version <n>]");
    output(await dependencies.recipes.get(name, version ? { version } : {}), json, dependencies.writeStdout);
    return 0;
  }

  if (subcommand === "create") {
    let file: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--file") {
        file = optionValue(rest, index, "--file");
        index += 1;
      } else if (rest[index] !== "--json") throw new UsageError(`Unknown recipes create option: ${rest[index]}`);
    }
    if (!file) throw new UsageError("Usage: mediaruntime recipes create --file <recipe.json>");
    const value = await recipeFile(file);
    if (typeof value.name !== "string" || typeof value.template !== "object") {
      throw new UsageError("Recipe JSON requires name and template");
    }
    output(await dependencies.recipes.create(value as unknown as CreateRecipeParams), json, dependencies.writeStdout);
    return 0;
  }

  if (subcommand === "version") {
    let name: string | undefined;
    let file: string | undefined;
    let expected: number | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index];
      if (value === "--file") {
        file = optionValue(rest, index, value);
        index += 1;
      } else if (value === "--expected") {
        expected = positiveInteger(optionValue(rest, index, value), value);
        index += 1;
      } else if (value !== "--json" && !name) name = value;
      else if (value !== "--json") throw new UsageError(`Unknown recipes version option: ${value}`);
    }
    if (!name || !file || !expected) {
      throw new UsageError("Usage: mediaruntime recipes version <name> --file <recipe.json> --expected <n>");
    }
    const value = await recipeFile(file);
    const template = value.template ?? value;
    output(await dependencies.recipes.createVersion(name, {
      expectedLatestVersion: expected,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      template: template as CreateRecipeVersionParams["template"],
    }), json, dependencies.writeStdout);
    return 0;
  }

  if (subcommand === "archive") {
    const values = rest.filter((value) => value !== "--json");
    if (values.length !== 1) throw new UsageError("Usage: mediaruntime recipes archive <name>");
    await dependencies.recipes.archive(values[0] ?? "");
    dependencies.writeStdout(json
      ? `${JSON.stringify({ name: values[0], status: "archived" })}\n`
      : `Archived recipe ${values[0]}\n`);
    return 0;
  }

  throw new UsageError("Usage: mediaruntime recipes <list|get|create|version|archive>");
}
