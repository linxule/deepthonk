import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = resolve("packages/cli/src/index.ts");

describe("deepthonk CLI", () => {
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

  it("rejects unsupported export formats", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "deepthonk-export-format-"));
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ run_id: "r", winner_id: "c", calls: 1 }));
    await expect(execFileAsync(process.execPath, ["--import", "tsx", cli, "export", runDir, "--format", "xml"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unsupported export format")
    });
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
