import type { Command } from "commander";
import { serveMcp } from "@deepthonk/mcp";
import { numberOption } from "../options.js";

export function registerServeMcp(program: Command): void {
  program
    .command("serve-mcp")
    .description("Start the DeepThonk MCP server.")
    .option("--transport <transport>", "stdio|http", "stdio")
    .option("--port <number>", "Port for HTTP transport.", "3333")
    .option("--max-active-jobs <number>", "Maximum active background jobs.", "2")
    .option("--max-queued-jobs <number>", "Maximum queued background jobs.", "32")
    .action(async (options) => {
      if (options.transport !== "stdio" && options.transport !== "http") {
        throw new Error(`Invalid --transport value: ${options.transport}. Use stdio or http.`);
      }
      const port = Number(options.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`Invalid --port value: ${options.port}`);
      }
      await serveMcp({
        transport: options.transport,
        port,
        maxActiveJobs: numberOption(options.maxActiveJobs, "--max-active-jobs", { integer: true, min: 1 }),
        maxQueuedJobs: numberOption(options.maxQueuedJobs, "--max-queued-jobs", { integer: true, min: 0 })
      });
    });
}
