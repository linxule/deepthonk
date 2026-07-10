#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`deepthonk unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
});

type CommandRegistrar = (program: Command) => void;

const commandLoaders: Record<string, () => Promise<CommandRegistrar>> = {
  plan: async () => (await import("./commands/plan.js")).registerPlan,
  profile: async () => (await import("./commands/profile/index.js")).registerProfile,
  run: async () => (await import("./commands/run.js")).registerRun,
  inspect: async () => (await import("./commands/inspect.js")).registerInspect,
  lock: async () => (await import("./commands/lock.js")).registerLock,
  resume: async () => (await import("./commands/resume.js")).registerResume,
  "repair-budget": async () => (await import("./commands/repairBudget.js")).registerRepairBudget,
  export: async () => (await import("./commands/export.js")).registerExport,
  rank: async () => (await import("./commands/rank.js")).registerRank,
  mutate: async () => (await import("./commands/mutate.js")).registerMutate,
  setup: async () => (await import("./commands/setup.js")).registerSetup,
  "serve-mcp": async () => (await import("./commands/serveMcp.js")).registerServeMcp
};

const program = new Command();
program.name("deepthonk").description("Thonk harder, not richer.").version(packageVersion()).option("--json-errors", "Print machine-readable errors to stderr.");

await registerCommandsForInvocation(program, process.argv.slice(2));

program.parseAsync(process.argv).catch(async (error) => {
  const opts = program.opts<{ jsonErrors?: boolean }>();
  if (opts.jsonErrors) {
    console.error(JSON.stringify(await serializeError(error), null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});

async function registerCommandsForInvocation(target: Command, argv: string[]): Promise<void> {
  if (argv.includes("--version") || argv.includes("-V")) return;
  const requested = requestedCommand(argv);
  const names = requested && commandLoaders[requested] ? [requested] : Object.keys(commandLoaders);
  const registrars = await Promise.all(names.map((name) => commandLoaders[name]()));
  for (const register of registrars) register(target);
}

function requestedCommand(argv: string[]): string | undefined {
  const operands = argv.filter((argument) => !argument.startsWith("-"));
  if (operands[0] === "help") return operands[1];
  return operands[0];
}

async function serializeError(error: unknown): Promise<Record<string, unknown>> {
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; fix?: unknown };
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  ) {
    return {
      code: candidate.code,
      message: candidate.message,
      retryable: candidate.retryable,
      ...(typeof candidate.fix === "string" ? { fix: candidate.fix } : {})
    };
  }
  return {
    code: "unexpected_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}

function packageVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return packageJson.version ?? "0.0.0";
}
