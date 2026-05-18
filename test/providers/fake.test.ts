import { describe, expect, it } from "vitest";
import { FakeDriver, quality } from "@deepthonk/providers";

describe("FakeDriver", () => {
  it("generates and mutates deterministic quality", async () => {
    const driver = new FakeDriver();
    const generated = await driver.generate({ task: "x", model: "fake", temperature: 0, candidateIndex: 1 });
    expect(quality(generated.text)).toBe(20);
    const mutated = await driver.mutate({
      task: "x",
      model: "fake",
      temperature: 0,
      critique: "",
      candidate: {
        id: "c",
        generation: 0,
        kind: "initial",
        content: generated.text,
        metadata: { createdAt: new Date().toISOString() }
      }
    });
    expect(quality(mutated.text)).toBe(27);
  });
});

