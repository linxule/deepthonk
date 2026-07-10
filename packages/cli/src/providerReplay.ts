import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderReplay } from "@deepthonk/providers";

export {
  assertProviderReplayFingerprint,
  parseProviderReplay,
  providerConfigFromReplay,
  providerReplayFromConfig,
  providerReplaySchema,
  providerRouteFingerprint,
  type ProviderReplay
} from "@deepthonk/providers";

export async function upsertProviderReplay(runDir: string, replay: ProviderReplay): Promise<void> {
  const configPath = join(runDir, "config.json");
  const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  raw.providerReplay = replay;
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, configPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
