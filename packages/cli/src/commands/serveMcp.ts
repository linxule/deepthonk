import type { Command } from "commander";
import { serveMcp } from "@deepthonk/mcp";

export function registerServeMcp(program: Command): void {
  program
    .command("serve-mcp")
    .description("Start the DeepThonk MCP server.")
    .option("--transport <transport>", "stdio|http", "stdio")
    .option("--port <number>", "Port for HTTP transport.", "3333")
    .action(async (options) => {
      const port = Number(options.port);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`Invalid --port value: ${options.port}`);
      }
      await serveMcp({ transport: options.transport, port });
    });
}

