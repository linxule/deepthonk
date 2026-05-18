import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const defaultConfigPath = join(homedir(), ".config", "deepthonk", "config.yaml");
export const defaultEnvPath = join(dirname(defaultConfigPath), "env");

export async function loadDeepThonkEnv(path = process.env.DEEPTHONK_ENV ?? defaultEnvPath): Promise<void> {
  if (!existsSync(path)) return;
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return undefined;
  return [match[1], unquoteEnvValue(match[2].trim())];
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    const inner = value.slice(1, -1);
    return value.startsWith("'") ? inner.replace(/'\\''/g, "'") : inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}
