#!/usr/bin/env node
import { Command } from "commander";
import { DeepThonkError } from "@deepthonk/core";
import { registerExport } from "./commands/export.js";
import { registerInspect } from "./commands/inspect.js";
import { registerMutate } from "./commands/mutate.js";
import { registerPlan } from "./commands/plan.js";
import { registerProfile } from "./commands/profile/index.js";
import { registerRank } from "./commands/rank.js";
import { registerResume } from "./commands/resume.js";
import { registerRun } from "./commands/run.js";
import { registerServeMcp } from "./commands/serveMcp.js";
import { registerSetup } from "./commands/setup.js";

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`deepthonk unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
});

const program = new Command();
program.name("deepthonk").description("Thonk harder, not richer.").version("0.1.2").option("--json-errors", "Print machine-readable errors to stderr.");

registerPlan(program);
registerProfile(program);
registerRun(program);
registerInspect(program);
registerResume(program);
registerExport(program);
registerRank(program);
registerMutate(program);
registerSetup(program);
registerServeMcp(program);

program.parseAsync(process.argv).catch((error) => {
  const opts = program.opts<{ jsonErrors?: boolean }>();
  if (opts.jsonErrors) {
    console.error(JSON.stringify(serializeError(error), null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof DeepThonkError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      fix: error.fix
    };
  }
  return {
    code: "unexpected_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}
