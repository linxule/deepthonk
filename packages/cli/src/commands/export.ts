import type { Command } from "commander";
import { exportRun } from "@deepthonk/core";
import { resolveCliPath } from "../config.js";

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export a DeepThonk run.")
    .argument("<runDir>")
    .option("--format <format>", "json|markdown|jsonl", "json")
    .action(async (runDir: string, options) => {
      if (!["json", "markdown", "jsonl"].includes(options.format)) throw new Error(`Unsupported export format: ${options.format}. Use json, markdown, or jsonl.`);
      runDir = resolveCliPath(runDir);
      const exported = await exportRun(runDir, options.format);
      if (options.format === "jsonl") {
        process.stdout.write(String(exported.jsonl ?? ""));
        return;
      }
      if (options.format === "markdown") console.log(exported.markdown);
      else console.log(JSON.stringify(exported, null, 2));
    });
}
