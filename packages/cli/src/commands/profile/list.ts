import type { Command } from "commander";
import { listProfiles, profilesDir } from "../../profileRegistry.js";

export function registerProfileList(profile: Command): void {
  profile
    .command("list")
    .description("List saved profile names.")
    .option("--json", "Print a JSON array.")
    .action(async (options) => {
      const profiles = await listProfiles();
      if (options.json) {
        console.log(JSON.stringify(profiles, null, 2));
        return;
      }
      if (profiles.length === 0) {
        process.stderr.write(`No saved profiles found in ${profilesDir()}.\n`);
        return;
      }
      process.stdout.write(`${profiles.join("\n")}\n`);
    });
}
