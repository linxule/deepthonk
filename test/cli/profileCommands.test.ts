import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = resolve("packages/cli/src/index.ts");

describe("deepthonk profile CLI", () => {
  it("lists an empty registry without failing", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-profiles-empty-"));
    const result = await runProfile(["list"], profilesDir);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No saved profiles found");
  });

  it("lists populated registry names as text and JSON", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-profiles-list-"));
    await writeFile(join(profilesDir, "beta.yaml"), validProfileYaml());
    await writeFile(join(profilesDir, "alpha.yaml"), validProfileYaml());

    const text = await runProfile(["list"], profilesDir);
    expect(text.stdout).toBe("alpha\nbeta\n");

    const json = await runProfile(["list", "--json"], profilesDir);
    expect(JSON.parse(json.stdout)).toEqual(["alpha", "beta"]);
  });

  it("shows a profile with secret-shaped values redacted and api_key_env visible", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-profiles-show-"));
    await writeFile(
      join(profilesDir, "with-secret.yaml"),
      [
        validProfileYaml(),
        "providers:",
        "  judge:",
        "    provider: fake",
        "    model: fake-model",
        "    authorization: Bearer raw-secret"
      ].join("\n")
    );

    const shown = await runProfile(["show", "with-secret"], profilesDir);
    const parsed = JSON.parse(shown.stdout);
    expect(parsed.api_key_env).toBe("DEEPTHONK_API_KEY");
    expect(parsed.providers.judge.authorization).toBe("[redacted]");
    expect(shown.stdout).not.toContain("raw-secret");
  });

  it("saves a profile from --from-config", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepthonk-cli-profile-from-config-"));
    const profilesDir = join(root, "profiles");
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, validProfileYaml());

    const saved = await runProfile(["save", "from-config", "--from-config", configPath], profilesDir);
    const savedPath = join(profilesDir, "from-config.yaml");
    expect(saved.stdout.trim()).toBe(savedPath);
    expect(await readFile(savedPath, "utf8")).toContain("prompt_style: general");
  });

  it("saves a profile from flags", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-profile-flags-"));
    const saved = await runProfile(
      [
        "save",
        "flagged",
        "--profile",
        "quick",
        "--prompt-style",
        "general",
        "--provider",
        "fake",
        "--api-key-env",
        "DEEPTHONK_API_KEY",
        "--generator-model",
        "fake-model",
        "--mutator-model",
        "fake-model",
        "--judge-model",
        "fake-model",
        "--n",
        "4",
        "--sample-temperature",
        "0.2"
      ],
      profilesDir
    );
    expect(saved.stdout.trim()).toBe(join(profilesDir, "flagged.yaml"));
    const shown = JSON.parse((await runProfile(["show", "flagged"], profilesDir)).stdout);
    expect(shown.algorithm.n).toBe(4);
    expect(shown.algorithm.sample_temperature).toBe(0.2);
  });

  it("refuses to overwrite without --force", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-profile-overwrite-"));
    await writeFile(join(profilesDir, "dupe.yaml"), validProfileYaml());

    await expect(runProfile(["save", "dupe", "--from-config", join(profilesDir, "dupe.yaml")], profilesDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("already exists")
    });
  });

  it("rejects raw --api-key", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-profile-api-key-"));
    await expect(
      runProfile(
        [
          "save",
          "bad-secret",
          "--profile",
          "quick",
          "--prompt-style",
          "general",
          "--provider",
          "fake",
          "--api-key",
          "raw-secret",
          "--generator-model",
          "fake-model",
          "--mutator-model",
          "fake-model",
          "--judge-model",
          "fake-model"
        ],
        profilesDir
      )
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Raw --api-key values are not allowed") });
  });

  it("deletes a profile with --yes", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-profile-delete-"));
    const path = join(profilesDir, "delete-me.yaml");
    await writeFile(path, validProfileYaml());

    const deleted = await runProfile(["delete", "delete-me", "--yes"], profilesDir);
    expect(deleted.stdout.trim()).toBe(`Deleted ${path}`);
    expect(existsSync(path)).toBe(false);
  });

  it("fails clearly when deleting without --yes", async () => {
    const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-cli-profile-delete-no-"));
    await writeFile(join(profilesDir, "keep-me.yaml"), validProfileYaml());

    await expect(runProfile(["delete", "keep-me"], profilesDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("Refusing to delete profile without --yes")
    });
  });
});

function runProfile(args: string[], profilesDir: string) {
  return execFileAsync(process.execPath, ["--import", "tsx", cli, "profile", ...args], {
    env: { ...process.env, DEEPTHONK_PROFILES_DIR: profilesDir }
  });
}

function validProfileYaml(): string {
  return [
    "profile: quick",
    "prompt_style: general",
    "provider: fake",
    "api_key_env: DEEPTHONK_API_KEY",
    "models:",
    "  generator: fake-model",
    "  mutator: fake-model",
    "  judge: fake-model"
  ].join("\n");
}
