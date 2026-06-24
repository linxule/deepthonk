import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveProviderConfig, type ProviderConfig, type ProviderRole } from "@deepthonk/providers";

const providerRoles = ["generator", "mutator", "judge", "finalizer"] as const satisfies readonly ProviderRole[];

const providerReplayRoleSchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  model: z.string().min(1),
  supportsJsonMode: z.boolean().default(true)
});

const providerReplaySchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  supportsJsonMode: z.boolean().default(true),
  models: z.object({
    generator: z.string().min(1),
    mutator: z.string().min(1),
    judge: z.string().min(1),
    finalizer: z.string().min(1).optional()
  }),
  roleProviders: z
    .object({
      generator: providerReplayRoleSchema.optional(),
      mutator: providerReplayRoleSchema.optional(),
      judge: providerReplayRoleSchema.optional(),
      finalizer: providerReplayRoleSchema.optional()
    })
    .optional()
});

export type ProviderReplay = z.infer<typeof providerReplaySchema>;

export function providerReplayFromConfig(config: ProviderConfig): ProviderReplay {
  const replay: ProviderReplay = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    supportsJsonMode: config.supportsJsonMode ?? true,
    models: compactObject({
      generator: config.models.generator,
      mutator: config.models.mutator,
      judge: config.models.judge,
      finalizer: config.models.finalizer
    }) as ProviderReplay["models"]
  };
  const roleProviders = replayRoleProviders(config);
  if (roleProviders) replay.roleProviders = roleProviders;
  return replay;
}

export function parseProviderReplay(value: unknown): ProviderReplay | undefined {
  const parsed = providerReplaySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function providerConfigFromReplay(replay: ProviderReplay, retry?: ProviderConfig["retry"]): ProviderConfig {
  return resolveProviderConfig({
    provider: replay.provider,
    baseUrl: replay.baseUrl,
    apiKeyEnv: replay.apiKeyEnv,
    supportsJsonMode: replay.supportsJsonMode,
    models: replay.models,
    roleProviders: replay.roleProviders,
    retry
  });
}

export async function upsertProviderReplay(runDir: string, replay: ProviderReplay): Promise<void> {
  const configPath = join(runDir, "config.json");
  const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  raw.providerReplay = replay;
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

function replayRoleProviders(config: ProviderConfig): ProviderReplay["roleProviders"] | undefined {
  if (!config.roleProviders) return undefined;
  const entries = providerRoles.flatMap((role) => {
    const roleConfig = config.roleProviders?.[role];
    if (!roleConfig) return [];
    return [
      [
        role,
        compactObject({
          provider: roleConfig.provider,
          baseUrl: roleConfig.baseUrl,
          apiKeyEnv: roleConfig.apiKeyEnv,
          model: roleConfig.model,
          supportsJsonMode: roleConfig.supportsJsonMode ?? config.supportsJsonMode ?? true
        })
      ] as const
    ];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as Partial<T>;
}
