import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveOneShotConfig } from "../../packages/cli/src/config.js";

const execFileAsync = promisify(execFile);
const cli = resolve("packages/cli/src/index.ts");

describe("deepthonk CLI", () => {
  it("prints the package metadata version", async () => {
    const expected = JSON.parse(await readFile(resolve("packages/cli/package.json"), "utf8")) as { version: string };
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "--version"]);
    expect(stdout.trim()).toBe(expected.version);
  });

  it("prints paper plan", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "plan", "--profile", "paper"]);
    expect(JSON.parse(stdout).calls).toBe(285);
  });

  it("prints plan from config", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "plan",
      "--config",
      "examples/configs/paper.deepseek.yaml"
    ]);
    expect(JSON.parse(stdout).profile).toBe("paper");
  });

  it("prints plan from config with algorithm overrides", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-plan-config-"));
    const configPath = join(configDir, "config.yaml");
    await writeFile(configPath, ["profile: paper", "algorithm:", "  n: 8", "  k: 2", "  t: 1", "  m: 4"].join("\n"));
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "plan", "--config", configPath]);
    const parsed = JSON.parse(stdout);
    expect(parsed.profile).toBe("custom");
    expect(parsed.calls).toBe(38);
  });

  it("plans config retry headroom and finalizer calls for snake_case and camelCase aliases", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-plan-retries-"));
    for (const [name, retryLine] of [["snake", "  invalid_json_retries: 2"], ["camel", "  invalidJsonRetries: 2"]] as const) {
      const configPath = join(configDir, `${name}.yaml`);
      await writeFile(
        configPath,
        [
          "profile: quick",
          "provider: fake",
          "models:",
          "  generator: fake-model",
          "  mutator: fake-model",
          "  judge: fake-model",
          "  finalizer: fake-finalizer",
          "retry:",
          retryLine
        ].join("\n")
      );
      const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "plan", "--config", configPath]);
      expect(JSON.parse(stdout)).toMatchObject({
        calls: 15,
        finalizer_calls: 1,
        invalid_json_retry_headroom_calls: 16,
        worst_case_calls: 32
      });
    }
  });

  it("plans named-profile retry headroom and finalizer presence", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-plan-profile-retries-"));
    await writeFile(
      join(profilesDir, "finalized.yaml"),
      [
        "profile: quick",
        "prompt_style: general",
        "provider: fake",
        "models:",
        "  generator: fake-model",
        "  mutator: fake-model",
        "  judge: fake-model",
        "  finalizer: fake-finalizer",
        "retry:",
        "  invalid_json_retries: 3"
      ].join("\n")
    );
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "plan", "--profile-name", "finalized"], {
      env: { ...process.env, DEEPTHONK_PROFILES_DIR: profilesDir }
    });
    expect(JSON.parse(stdout)).toMatchObject({
      calls: 15,
      finalizer_calls: 1,
      invalid_json_retry_headroom_calls: 24,
      worst_case_calls: 40
    });
  });

  it("resolves run config paths from the original workspace cwd", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "run",
      "--config",
      "examples/configs/quick.fake.yaml",
      "--task",
      "examples/tasks/toy-math.txt",
      "--dry-run"
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.runConfig.provider).toBe("fake");
    expect(parsed.providerConfig.apiKeyEnv).toBeUndefined();
    expect(parsed.providerConfig.apiKeyPresent).toBe(false);
  });

  it("rejects task values that look like missing paths", async () => {
    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--provider", "fake", "--task", "examples/tasks/missing-task.txt", "--dry-run"])
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Input path does not exist") });
  });

  it("supports OpenRouter and role-specific provider config in dry run", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-provider-config-"));
    const configPath = join(configDir, "mixed.yaml");
    await writeFile(
      configPath,
      [
        "profile: quick",
        "provider: openrouter",
        "api_key_env: OPENROUTER_API_KEY",
        "models:",
        "  generator: openrouter/auto",
        "  mutator: openrouter/auto",
        "  judge: openrouter/auto",
        "providers:",
        "  judge:",
        "    provider: deepseek",
        "    api_key_env: DEEPSEEK_API_KEY",
        "    model: deepseek-v4-pro"
      ].join("\n")
    );

    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "run",
      "--config",
      configPath,
      "--task",
      "toy",
      "--dry-run"
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.providerConfig.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(parsed.providerConfig.roleProviders.judge).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  it("applies concurrency precedence and JSON-mode support config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-concurrency-config-"));
    const configPath = join(configDir, "mixed.yaml");
    await writeFile(
      configPath,
      [
        "profile: quick",
        "provider: fake",
        "supports_json_mode: false",
        "models:",
        "  generator: fake-model",
        "  mutator: fake-model",
        "  judge: fake-model",
        "providers:",
        "  judge:",
        "    provider: openai-compatible",
        "    base_url: https://judge.example.test/v1",
        "    api_key_env: JUDGE_KEY",
        "    model: judge-model",
        "    supports_json_mode: true",
        "concurrency:",
        "  generate: 2",
        "  judge: 3",
        "  mutate: 4"
      ].join("\n")
    );

    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "run",
      "--config",
      configPath,
      "--task",
      "toy",
      "--max-concurrency",
      "5",
      "--judge-concurrency",
      "7",
      "--dry-run"
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.runConfig.concurrency).toEqual({ generate: 5, judge: 7, mutate: 5 });
    expect(parsed.providerConfig.supportsJsonMode).toBe(false);
    expect(parsed.providerConfig.roleProviders.judge.supportsJsonMode).toBe(true);
    expect(parsed.providerReplay).toMatchObject({
      provider: "fake",
      supportsJsonMode: false,
      roleProviders: { judge: { supportsJsonMode: true, apiKeyEnv: "JUDGE_KEY" } }
    });
  });

  it("honors canonical snake_case budgets and rejects unknown or conflicting config keys", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-strict-config-"));
    const configPath = join(configDir, "strict.yaml");
    await writeFile(configPath, ["profile: quick", "provider: fake", "budget:", "  max_calls: 50", "retry:", "  http_retries: 0"].join("\n"));
    const resolved = await resolveOneShotConfig({ config: configPath });
    expect(resolved.retry.httpRetries).toBe(0);
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--config", configPath, "--task", "toy", "--dry-run"]);
    expect(JSON.parse(stdout).runConfig.budget.maxCalls).toBe(50);

    await writeFile(configPath, ["profile: quick", "provider: fake", "budget:", "  max_calls: 50", "  maxCalls: 60"].join("\n"));
    await expect(resolveOneShotConfig({ config: configPath })).rejects.toMatchObject({ code: "config.alias_conflict" });
    await writeFile(configPath, ["profile: quick", "provider: fake", "budegt:", "  max_calls: 50"].join("\n"));
    await expect(resolveOneShotConfig({ config: configPath })).rejects.toMatchObject({ code: "config.unknown_key" });
  });

  it("isolates CLI provider and endpoint changes from config credentials and models", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-isolated-route-"));
    const configPath = join(configDir, "route.yaml");
    await writeFile(
      configPath,
      [
        "profile: quick",
        "provider: deepseek",
        "base_url: https://api.deepseek.com/v1",
        "api_key_env: DEEPSEEK_API_KEY",
        "supports_json_mode: false",
        "models:",
        "  generator: deepseek-old",
        "  mutator: deepseek-old",
        "  judge: deepseek-old"
      ].join("\n")
    );

    const changedProvider = await resolveOneShotConfig({ config: configPath, provider: "openrouter" });
    expect(changedProvider.providerConfig).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      models: { generator: "openrouter/auto", mutator: "openrouter/auto", judge: "openrouter/auto" }
    });
    expect(changedProvider.providerConfig.supportsJsonMode).toBeUndefined();

    const changedEndpoint = await resolveOneShotConfig({ config: configPath, baseUrl: "https://proxy.example.test/v1" });
    expect(changedEndpoint.providerConfig.baseUrl).toBe("https://proxy.example.test/v1");
    expect(changedEndpoint.providerConfig.apiKeyEnv).toBeUndefined();
    expect(changedEndpoint.providerConfig.models.judge).toBe("deepseek-v4-pro");
    expect(changedEndpoint.providerConfig.supportsJsonMode).toBeUndefined();
  });

  it("rejects invalid numeric and boolean CLI options", async () => {
    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--provider", "fake", "--task", "toy", "--n", "3.5", "--dry-run"])
    ).rejects.toMatchObject({ stderr: expect.stringContaining("--n must be an integer >= 2") });

    await expect(
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        cli,
        "run",
        "--provider",
        "fake",
        "--task",
        "toy",
        "--supports-json-mode",
        "maybe",
        "--dry-run"
      ])
    ).rejects.toMatchObject({ stderr: expect.stringContaining("--supports-json-mode must be true or false") });

    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--provider", "fake", "--task", "toy", "--n", "", "--dry-run"])
    ).rejects.toMatchObject({ stderr: expect.stringContaining("--n must be a decimal number") });

    await expect(
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        cli,
        "run",
        "--provider",
        "fake",
        "--task",
        "toy",
        "--supports-json-mode",
        "",
        "--dry-run"
      ])
    ).rejects.toMatchObject({ stderr: expect.stringContaining("--supports-json-mode must be true or false") });
  });

  it("sets up reusable provider config and env file", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-setup-"));
    const configPath = join(configDir, "config.yaml");
    const envPath = join(configDir, "env");

    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "setup",
      "--config",
      configPath,
      "--key-file",
      envPath,
      "--provider",
      "deepseek",
      "--api-key",
      "secret-test-key",
      "--fast-model",
      "deepseek-v4-flash",
      "--judge-model",
      "deepseek-v4-pro"
    ]);

    const setup = JSON.parse(stdout);
    expect(setup.config_path).toBe(configPath);
    expect(await readFile(configPath, "utf8")).toContain("judge: deepseek-v4-pro");
    expect(await readFile(envPath, "utf8")).toContain("DEEPSEEK_API_KEY=");

    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--task", "toy", "--dry-run"], {
      env: { ...process.env, DEEPTHONK_CONFIG: configPath, DEEPTHONK_ENV: envPath, DEEPSEEK_API_KEY: "" }
    });
    const parsed = JSON.parse(dryRun.stdout);
    expect(parsed.runConfig.provider).toBe("deepseek");
    expect(parsed.runConfig.budget.prices).toContainEqual(
      expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-pro", outputUsdPerMillion: 0.87 })
    );
    expect(parsed.providerConfig.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(parsed.providerConfig.apiKeyPresent).toBe(true);
    expect(dryRun.stdout).not.toContain("secret-test-key");
  });

  it("lets rank and mutate reuse setup config and JSON output", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-one-shot-"));
    const configPath = join(configDir, "config.yaml");
    const candidatesPath = join(configDir, "candidates.jsonl");
    const candidatePath = join(configDir, "candidate.txt");
    const critiquePath = join(configDir, "critique.txt");
    await writeFile(configPath, ["profile: quick", "provider: fake", "models:", "  generator: fake-model", "  mutator: fake-model", "  judge: fake-model"].join("\n"));
    await writeFile(candidatesPath, "{\"content\":\"FAKE_QUALITY:1\"}\n{\"content\":\"FAKE_QUALITY:9\"}\n");
    await writeFile(candidatePath, "FAKE_QUALITY:1");
    await writeFile(critiquePath, "raise quality");

    const ranked = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "rank",
      "--config",
      configPath,
      "--task",
      "toy",
      "--candidates",
      candidatesPath
    ]);
    expect(JSON.parse(ranked.stdout)[0].candidateId).toBe("candidate-2");

    const mutated = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "mutate",
      "--config",
      configPath,
      "--task",
      "toy",
      "--candidate",
      candidatePath,
      "--critique",
      critiquePath,
      "--json"
    ]);
    expect(JSON.parse(mutated.stdout).mutated).toContain("FAKE_QUALITY:8");
  });

  it("resolves one-shot command defaults from config/profile before inline overrides", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-one-shot-defaults-"));
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      [
        "profile: quick",
        "prompt_style: paper-programming",
        "provider: fake",
        "models:",
        "  generator: fake-model",
        "  mutator: fake-model",
        "  judge: fake-model",
        "algorithm:",
        "  lambda: 0.2",
        "  mutate_temperature: 0.4",
        "  judge_temperature: 0.3",
        "retry:",
        "  requestTimeoutMs: 1234",
        "prompts:",
        "  compare:",
        "    system: Config judge",
        "  mutate:",
        "    system: Config mutate"
      ].join("\n")
    );

    const resolved = await resolveOneShotConfig({
      config: configPath,
      requestTimeoutMs: "5678",
      judgeTemperature: "0.5",
      promptsJson: JSON.stringify({ compare: { system: "Inline judge" } })
    });

    expect(resolved.profile.lambda).toBe(0.2);
    expect(resolved.profile.mutateTemperature).toBe(0.4);
    expect(resolved.profile.judgeTemperature).toBe(0.5);
    expect(resolved.retry.requestTimeoutMs).toBe(5678);
    expect(resolved.promptStyle).toBe("paper-programming");
    expect(resolved.promptOverrides?.compare?.system).toBe("Inline judge");
    expect(resolved.promptOverrides?.mutate?.system).toBe("Config mutate");
  });

  it("writes redacted providerReplay into run config", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-replay-config-"));
    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "run",
        "--provider",
        "fake",
        "--base-url",
        "https://example.test/v1",
        "--api-key-env",
        "TEST_PROVIDER_KEY",
        "--supports-json-mode",
        "false",
        "--profile",
        "quick",
        "--task",
        "toy",
        "--out",
        runDir
      ],
      { env: { ...process.env, TEST_PROVIDER_KEY: "secret-test-key" } }
    );

    const stored = JSON.parse(await readFile(join(runDir, "config.json"), "utf8"));
    expect(stored.providerReplay).toMatchObject({
      provider: "fake",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "TEST_PROVIDER_KEY",
      supportsJsonMode: false,
      models: { generator: "fake-model", mutator: "fake-model", judge: "fake-model" }
    });
    expect(JSON.stringify(stored)).not.toContain("secret-test-key");
    expect(stored.providerReplay.apiKey).toBeUndefined();
    expect(stored.providerReplay.roleProviders?.judge?.apiKey).toBeUndefined();
  });

  it("resumes with providerReplay when the legacy config shape lacks provider connection fields", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-resume-replay-"));
    const version = await currentCoreVersion();
    await writeFile(
      join(runDir, "config.json"),
      JSON.stringify(
        {
          version,
          task: "toy",
          promptStyle: "general",
          profile: { n: 4, k: 2, t: 1, m: 2, lambda: 0.01, sampleTemperature: 1, mutateTemperature: 1, judgeTemperature: 0 },
          runDir,
          seed: 1,
          provider: "openai-compatible",
          generatorModel: "m",
          mutatorModel: "m",
          judgeModel: "m",
          concurrency: { generate: 1, judge: 1, mutate: 1 },
          retry: { httpRetries: 0, invalidJsonRetries: 1 },
          output: { includeRawModelOutputs: false, includePrompts: false },
          providerReplay: {
            provider: "openai-compatible",
            baseUrl: "https://example.test/v1",
            apiKeyEnv: "TEST_PROVIDER_KEY",
            supportsJsonMode: false,
            models: { generator: "m", mutator: "m", judge: "m" }
          }
        },
        null,
        2
      )
    );

    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "resume", runDir, "--continue", "--dry-run"], {
      env: { ...process.env, TEST_PROVIDER_KEY: "" }
    });
    expect(JSON.parse(stdout)).toMatchObject({ status: "resumable", phase: "initial_generation", safe_to_continue: true });
  });

  it("repairs legacy-redacted budget fields through the supported CLI surface", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-budget-repair-"));
    await writeFile(join(runDir, "config.json"), JSON.stringify({ budget: { maxInputTokens: "[redacted]" } }));
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", cli, "repair-budget", runDir, "--set", "budget.maxInputTokens=1234"
    ]);
    expect(JSON.parse(stdout)).toEqual({ repaired: ["budget.maxInputTokens"] });
    expect(JSON.parse(await readFile(join(runDir, "config.json"), "utf8"))).toMatchObject({ budget: { maxInputTokens: 1234 } });
  });

  it("rejects unsupported export formats", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-export-format-"));
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: "r", winner_id: "c", calls: 1 }));
    await expect(execFileAsync(process.execPath, ["--import", "tsx", cli, "export", runDir, "--format", "xml"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unsupported export format")
    });
  });

  it("overrides profile n/k/t/m and temperatures via CLI flags", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "run",
      "--provider",
      "fake",
      "--profile",
      "paper",
      "--task",
      "toy",
      "--n",
      "12",
      "--k",
      "2",
      "--t",
      "1",
      "--m",
      "6",
      "--lambda",
      "0.05",
      "--sample-temperature",
      "1.4",
      "--dry-run"
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.runConfig.profile.n).toBe(12);
    expect(parsed.runConfig.profile.k).toBe(2);
    expect(parsed.runConfig.profile.t).toBe(1);
    expect(parsed.runConfig.profile.m).toBe(6);
    expect(parsed.runConfig.profile.lambda).toBe(0.05);
    expect(parsed.runConfig.profile.sampleTemperature).toBe(1.4);
  });

  it("loads prompt overrides from --prompts YAML file", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-prompts-"));
    const promptsPath = join(configDir, "prompts.yaml");
    await writeFile(
      promptsPath,
      [
        "generate:",
        "  system: 'You are an experienced employment-law attorney.'",
        "  user: 'TASK: {task}\\nProduce one drafted clause.'",
        "compare:",
        "  user: 'Pick the more enforceable clause. JSON only.'"
      ].join("\n")
    );
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "run",
      "--provider",
      "fake",
      "--profile",
      "quick",
      "--task",
      "toy",
      "--prompts",
      promptsPath,
      "--dry-run"
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.runConfig.promptOverrides.generate.system).toContain("attorney");
    expect(parsed.runConfig.promptOverrides.compare.user).toContain("enforceable");
  });

  it("loads prompt overrides from inline --prompts-json after YAML", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "deepthonk-prompts-json-"));
    const promptsPath = join(configDir, "prompts.yaml");
    await writeFile(promptsPath, ["generate:", "  system: 'YAML prompt'"].join("\n"));
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "run",
      "--provider",
      "fake",
      "--profile",
      "quick",
      "--task",
      "toy",
      "--prompts",
      promptsPath,
      "--prompts-json",
      JSON.stringify({ generate: { system: "JSON prompt" }, compare: { system: "Judge from JSON" } }),
      "--dry-run"
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.runConfig.promptOverrides.generate.system).toBe("JSON prompt");
    expect(parsed.runConfig.promptOverrides.compare.system).toBe("Judge from JSON");
  });

  it("--prompt-style overrides profile-derived default", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "run",
      "--provider",
      "fake",
      "--profile",
      "quick",
      "--task",
      "toy",
      "--prompt-style",
      "paper-programming",
      "--dry-run"
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.runConfig.promptStyle).toBe("paper-programming");
  });

  it("loads a named profile via --profile-name", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-profiles-"));
    await writeFile(
      join(profilesDir, "fake-balanced.yaml"),
      [
        "profile: balanced",
        "prompt_style: general",
        "provider: fake",
        "models:",
        "  generator: fake-model",
        "  mutator: fake-model",
        "  judge: fake-model",
        "algorithm:",
        "  judge_temperature: 0.2"
      ].join("\n")
    );
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--profile-name", "fake-balanced", "--task", "toy", "--dry-run"], {
      env: { ...process.env, DEEPTHONK_PROFILES_DIR: profilesDir }
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.runConfig.provider).toBe("fake");
    expect(parsed.runConfig.profile.judgeTemperature).toBe(0.2);
    expect(parsed.runConfig.profile.n).toBe(8);
  });

  it("rejects --profile-name combined with --config", async () => {
    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--profile-name", "anything", "--config", "examples/configs/quick.fake.yaml", "--task", "toy", "--dry-run"])
    ).rejects.toMatchObject({ stderr: expect.stringContaining("--profile-name and --config cannot be used together") });
  });

  it("emits a clear error when the named profile is missing", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-profiles-missing-"));
    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--profile-name", "does-not-exist", "--task", "toy", "--dry-run"], {
        env: { ...process.env, DEEPTHONK_PROFILES_DIR: profilesDir }
      })
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Named profile 'does-not-exist' not found") });
  });

  it("rejects named profiles that contain a raw api_key", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-profiles-secret-"));
    await writeFile(
      join(profilesDir, "leaky.yaml"),
      [
        "profile: quick",
        "prompt_style: general",
        "provider: fake",
        "api_key: sk-secret-do-not-write",
        "models:",
        "  generator: fake-model",
        "  mutator: fake-model",
        "  judge: fake-model"
      ].join("\n")
    );
    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--profile-name", "leaky", "--task", "toy", "--dry-run"], {
        env: { ...process.env, DEEPTHONK_PROFILES_DIR: profilesDir }
      })
    ).rejects.toMatchObject({ stderr: expect.stringContaining("must not contain a raw 'api_key' value") });
  });

  it("lets CLI flags override named profile fields", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-profiles-override-"));
    await writeFile(
      join(profilesDir, "base.yaml"),
      [
        "profile: balanced",
        "prompt_style: general",
        "provider: fake",
        "models:",
        "  generator: fake-model",
        "  mutator: fake-model",
        "  judge: fake-model"
      ].join("\n")
    );
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "run", "--profile-name", "base", "--judge-temperature", "0.5", "--task", "toy", "--dry-run"], {
      env: { ...process.env, DEEPTHONK_PROFILES_DIR: profilesDir }
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.runConfig.profile.judgeTemperature).toBe(0.5);
  });

  it("plans from a named profile", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-profiles-plan-"));
    await writeFile(
      join(profilesDir, "p.yaml"),
      [
        "profile: paper",
        "prompt_style: paper-programming",
        "provider: fake",
        "models:",
        "  generator: fake-model",
        "  mutator: fake-model",
        "  judge: fake-model",
        "algorithm:",
        "  n: 8",
        "  k: 2",
        "  t: 1",
        "  m: 4"
      ].join("\n")
    );
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "plan", "--profile-name", "p"], {
      env: { ...process.env, DEEPTHONK_PROFILES_DIR: profilesDir }
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.calls).toBe(38);
  });

  it("runs fake quick profile and writes final artifact", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-"));
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      cli,
      "run",
      "--provider",
      "fake",
      "--profile",
      "quick",
      "--task",
      "examples/tasks/toy-math.txt",
      "--out",
      runDir
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.run_dir).toBe(runDir);
    const inspected = await execFileAsync(process.execPath, ["--import", "tsx", cli, "inspect", runDir]);
    expect(JSON.parse(inspected.stdout).summary.winner_id).toBe(parsed.winner_id);
  });
});

async function currentCoreVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(resolve("packages/core/package.json"), "utf8")) as { version: string };
  return packageJson.version;
}
