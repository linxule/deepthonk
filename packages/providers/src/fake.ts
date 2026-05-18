import type {
  CompareInput,
  FinalizeInput,
  GenerateInput,
  ModelDriver,
  ModelTextResult,
  MutateInput
} from "@deepthonk/core";

export interface FakeDriverOptions {
  seed?: number;
  failEvery?: number;
  invalidJsonEvery?: number;
}

export class FakeDriver implements ModelDriver {
  private calls = 0;

  constructor(private readonly options: FakeDriverOptions = {}) {}

  async generate(input: GenerateInput): Promise<ModelTextResult> {
    this.tick();
    const index = input.candidateIndex ?? 0;
    const quality = (index + 1) * 10;
    return this.result(`FAKE_QUALITY:${quality}\nCandidate ${index + 1}: deterministic answer for ${input.task}`);
  }

  async compare(input: CompareInput): Promise<ModelTextResult> {
    this.tick();
    if (this.options.invalidJsonEvery && this.calls % this.options.invalidJsonEvery === 0) {
      return this.result("not json");
    }
    const qa = quality(input.candidateA.content);
    const qb = quality(input.candidateB.content);
    const winner = qa === qb ? "tie" : qa > qb ? "A" : "B";
    return this.result(
      JSON.stringify({
        winner,
        confidence: winner === "tie" ? 0.5 : 0.9,
        critique_for_A: qa >= qb ? "A is comparatively strong." : "A is weaker on the synthetic quality signal.",
        critique_for_B: qb >= qa ? "B is comparatively strong." : "B is weaker on the synthetic quality signal.",
        selection_reason: `Synthetic quality ${qa} vs ${qb}.`
      })
    );
  }

  async mutate(input: MutateInput): Promise<ModelTextResult> {
    this.tick();
    const nextQuality = quality(input.candidate.content) + 7;
    return this.result(`FAKE_QUALITY:${nextQuality}\nImproved from ${input.candidate.id}. ${input.candidate.content}`);
  }

  async finalize(input: FinalizeInput): Promise<ModelTextResult> {
    this.tick();
    return this.result(input.candidate.content.replace(/^FAKE_QUALITY:\d+\n/, ""));
  }

  private tick(): void {
    this.calls += 1;
    if (this.options.failEvery && this.calls % this.options.failEvery === 0) {
      throw new Error(`Fake seeded failure at call ${this.calls}.`);
    }
  }

  private result(text: string): ModelTextResult {
    return {
      text,
      model: "fake-model",
      provider: "fake",
      usage: {
        inputTokens: Math.ceil(text.length / 6),
        outputTokens: Math.ceil(text.length / 5),
        totalTokens: Math.ceil(text.length / 3)
      },
      latencyMs: 0,
      retryCount: 0
    };
  }
}

export function quality(text: string): number {
  const match = text.match(/FAKE_QUALITY:(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}
