import type { Command } from "commander";
import { registerProfileDelete } from "./delete.js";
import { registerProfileList } from "./list.js";
import { registerProfileSave } from "./save.js";
import { registerProfileShow } from "./show.js";

export function registerProfile(program: Command): void {
  const profile = program.command("profile").description("Manage saved named profiles.");
  registerProfileList(profile);
  registerProfileShow(profile);
  registerProfileSave(profile);
  registerProfileDelete(profile);
}
