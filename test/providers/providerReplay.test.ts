import { describe, expect, it } from "vitest";
import {
  createDriver,
  createDriverIdentity,
  parseProviderReplay,
  providerConfigFromReplay,
  providerReplayFromConfig,
  providerRouteFingerprint,
  resolveProviderConfig
} from "@deepthonk/providers";

describe("provider replay", () => {
  it("persists sampling preferences and a stable route fingerprint without secrets", () => {
    const replay = providerReplayFromConfig(
      resolveProviderConfig({
        provider: "sampling",
        models: { generator: "g", mutator: "m", judge: "j" },
        modelHints: ["fast"],
        speedPriority: 0.8,
        intelligencePriority: 0.6
      })
    );

    expect(replay.samplingPreferences).toEqual({ modelHints: ["fast"], speedPriority: 0.8, intelligencePriority: 0.6 });
    expect(replay.routeFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(providerRouteFingerprint(replay)).toBe(replay.routeFingerprint);
    expect(JSON.stringify(replay)).not.toContain("apiKey\"");
    expect(providerConfigFromReplay(replay)).toMatchObject({ modelHints: ["fast"], speedPriority: 0.8 });
  });

  it("accepts legacy replay records and rejects fingerprinted route tampering", () => {
    const replay = providerReplayFromConfig(
      resolveProviderConfig({ provider: "deepseek", models: { generator: "g", mutator: "m", judge: "j" } })
    );
    const { routeFingerprint: _fingerprint, ...legacy } = replay;
    expect(parseProviderReplay(legacy)).toMatchObject({ provider: "deepseek" });
    expect(() => parseProviderReplay({ ...replay, baseUrl: "https://attacker.example/v1" })).toThrow(
      expect.objectContaining({ code: "provider.replay_route_mismatch" })
    );
  });

  it("carries the replay fingerprint onto the runtime driver", () => {
    const replay = providerReplayFromConfig(resolveProviderConfig({ provider: "fake" }));
    const config = providerConfigFromReplay(replay);
    const driver = createDriver(config) as { routeFingerprint?: string };
    expect(config.routeFingerprint).toBe(replay.routeFingerprint);
    expect(driver.routeFingerprint).toBe(replay.routeFingerprint);
  });

  it("creates a credential-free dry-run identity with the replay route", async () => {
    const replay = providerReplayFromConfig(
      resolveProviderConfig({
        provider: "openai-compatible",
        baseUrl: "https://provider.example.test/v1",
        apiKeyEnv: "ABSENT_TEST_KEY",
        models: { generator: "g", mutator: "m", judge: "j" }
      })
    );
    const config = providerConfigFromReplay(replay);
    const identity = createDriverIdentity(config) as ReturnType<typeof createDriverIdentity> & {
      provider?: string;
      baseUrl?: string;
      routeFingerprint?: string;
    };

    expect(identity).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://provider.example.test/v1",
      routeFingerprint: replay.routeFingerprint
    });
    await expect(identity.generate({ task: "x", model: "g", temperature: 0 })).rejects.toMatchObject({
      code: "provider.identity_driver_call"
    });
  });

  it("restores provider concurrency onto base and role routes", () => {
    const replay = providerReplayFromConfig(
      resolveProviderConfig({
        provider: "openai-compatible",
        baseUrl: "https://provider.example.test/v1",
        apiKeyEnv: "BASE_KEY",
        models: { generator: "g", mutator: "m", judge: "j" },
        roleProviders: {
          judge: {
            provider: "openai-compatible",
            baseUrl: "https://judge.example.test/v1",
            apiKeyEnv: "JUDGE_KEY",
            model: "judge"
          }
        }
      })
    );
    const restored = providerConfigFromReplay(replay, undefined, { providerMaxConcurrency: 6 });
    expect(restored.providerMaxConcurrency).toBe(6);
    expect(restored.roleProviders?.judge?.providerMaxConcurrency).toBe(6);
  });
});
