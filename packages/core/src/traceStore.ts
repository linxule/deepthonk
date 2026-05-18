import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runArtifactFiles, traceJsonlFiles } from "./artifacts.js";
import { TraceError } from "./errors.js";
import type { RunStatus } from "./lifecycle.js";
import type { BtScore, Candidate, Comparison, RunConfig } from "./schemas.js";

export class TraceStore {
  readonly runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  async init(config: RunConfig, runId: string): Promise<void> {
    await mkdir(join(this.runDir, "artifacts"), { recursive: true });
    await this.assertFreshTrace();
    await this.writeJson(runArtifactFiles.config, redactConfig({ ...config, runId }));
    await this.event({ type: "run.started", run_id: runId, created_at: new Date().toISOString() });
  }

  async event(event: Record<string, unknown>): Promise<void> {
    await this.appendJsonl(runArtifactFiles.trace, event);
  }

  async writeCandidate(candidate: Candidate): Promise<void> {
    await this.appendJsonl(runArtifactFiles.candidates, candidate);
  }

  async writeComparison(comparison: Comparison): Promise<void> {
    await this.appendJsonl(runArtifactFiles.comparisons, comparison);
  }

  async writeScores(generation: number | "final", scores: BtScore[]): Promise<void> {
    for (const score of scores) await this.appendJsonl(runArtifactFiles.scores, score);
    await this.event({ type: "scores.computed", generation });
  }

  async writePopulation(generation: number, population: Candidate[]): Promise<void> {
    await this.writeJson(`population-${generation}.json`, population);
  }

  async writeSummary(summary: Record<string, unknown>, finalAnswer: string, winnerAnswer?: string): Promise<void> {
    if (winnerAnswer !== undefined) await writeFile(join(this.runDir, runArtifactFiles.winner), winnerAnswer, "utf8");
    await writeFile(join(this.runDir, runArtifactFiles.final), finalAnswer, "utf8");
    await this.writeJson(runArtifactFiles.summary, summary);
  }

  async writeStatus(status: RunStatus): Promise<void> {
    await this.writeJson(runArtifactFiles.status, status);
  }

  async readSummary(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(this.runDir, runArtifactFiles.summary), "utf8")) as Record<string, unknown>;
  }

  async readJsonl<T>(fileName: string): Promise<T[]> {
    try {
      const text = await readFile(join(this.runDir, fileName), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      throw new TraceError(`Could not read ${fileName}: ${(error as Error).message}`);
    }
  }

  async listFiles(): Promise<string[]> {
    return readdir(this.runDir);
  }

  private async appendJsonl(fileName: string, value: unknown): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await writeFile(join(this.runDir, fileName), `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
  }

  private async writeJson(fileName: string, value: unknown): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await writeFile(join(this.runDir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private async assertFreshTrace(): Promise<void> {
    const traceFiles = [...traceJsonlFiles, runArtifactFiles.summary];
    for (const file of traceFiles) {
      try {
        await access(join(this.runDir, file));
        throw new TraceError(`Run directory already contains ${file}; choose a new --out directory or remove the old trace first.`);
      } catch (error) {
        if (error instanceof TraceError) throw error;
      }
    }
  }
}

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  return redactValue(config) as Record<string, unknown>;
}

function redactValue(value: unknown, key = ""): unknown {
  if (/apiKey|api_key|token|secret|password/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]));
  }
  return value;
}
