import type { Command } from "commander";
import { serveMcp } from "@deepthonk/mcp";

export function registerServeMcp(program: Command): void {
  program
    .command("serve-mcp")
    .description("Start the DeepThonk MCP server.")
    .option("--transport <transport>", "stdio|http", "stdio")
    .option("--port <number>", "3333")
    .action(async (options) => {
      await serveMcp({ transport: options.transport, port: Number(options.port) });
    });
}

