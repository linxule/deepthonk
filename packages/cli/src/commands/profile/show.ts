import type { Command } from "commander";
import { loadNamedProfile } from "../../profileRegistry.js";
import { redacted } from "../../redaction.js";

export function registerProfileShow(profile: Command): void {
  profile
    .command("show")
    .description("Show a saved profile; manually edited secret-shaped values are rejected on load.")
    .argument("<name>")
    .action(async (name) => {
      console.log(JSON.stringify(redacted(await loadNamedProfile(name)), null, 2));
    });
}
