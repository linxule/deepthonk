import { unlink } from "node:fs/promises";
import type { Command } from "commander";
import { ConfigError } from "@deepthonk/core";
import { loadNamedProfile, profilePath } from "../../profileRegistry.js";

export function registerProfileDelete(profile: Command): void {
  profile
    .command("delete")
    .description("Delete a saved profile.")
    .argument("<name>")
    .option("--yes", "Confirm deletion.")
    .action(async (name, options) => {
      if (!options.yes) {
        throw new ConfigError("Refusing to delete profile without --yes.", {
          code: "config.profile_delete_confirmation_required",
          retryable: false,
          fix: "Re-run with --yes to confirm deletion."
        });
      }
      await loadNamedProfile(name);
      const path = profilePath(name);
      await unlink(path);
      console.log(`Deleted ${path}`);
    });
}
