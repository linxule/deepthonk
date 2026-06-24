import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadNamedProfile } from "@deepthonk/providers";

describe("profile registry", () => {
  it.each([
    ["algorithm.api_key", ["algorithm:", "  api_key: secret"]],
    ["prompts.generate.api_key", ["prompts:", "  generate:", "    api_key: secret"]],
    ["algorithm.nested.api_key", ["algorithm:", "  nested:", "    api_key: secret"]]
  ])("rejects raw api_key recursively at %s", async (_path, extraYaml) => {
    await withProfilesDir(async (profilesDir) => {
      await writeFile(join(profilesDir, "bad.yaml"), [...validProfileYamlLines(), ...extraYaml].join("\n"));

      await expect(loadNamedProfile("bad")).rejects.toMatchObject({ code: "config.profile_raw_api_key" });
    });
  });

  it.each([
    ["top-level token", ["token: secret"]],
    ["provider authorization", ["providers:", "  judge:", "    authorization: Bearer secret"]],
    ["prompt password", ["prompts:", "  generate:", "    password: secret"]]
  ])("rejects secret-shaped fields beyond api_key at %s", async (_path, extraYaml) => {
    await withProfilesDir(async (profilesDir) => {
      await writeFile(join(profilesDir, "bad.yaml"), [...validProfileYamlLines(), ...extraYaml].join("\n"));

      await expect(loadNamedProfile("bad")).rejects.toMatchObject({ code: "config.profile_raw_secret" });
    });
  });
});

async function withProfilesDir<T>(action: (profilesDir: string) => Promise<T>): Promise<T> {
  const profilesDir = await mkdtemp(join(tmpdir(), "deepthonk-provider-profiles-"));
  const originalDir = process.env.DEEPTHONK_PROFILES_DIR;
  process.env.DEEPTHONK_PROFILES_DIR = profilesDir;
  try {
    return await action(profilesDir);
  } finally {
    if (originalDir === undefined) delete process.env.DEEPTHONK_PROFILES_DIR;
    else process.env.DEEPTHONK_PROFILES_DIR = originalDir;
  }
}

function validProfileYamlLines(): string[] {
  return [
    "profile: quick",
    "prompt_style: general",
    "provider: fake",
    "models:",
    "  generator: fake-model",
    "  mutator: fake-model",
    "  judge: fake-model"
  ];
}
