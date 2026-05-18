import { describe, expect, it } from "vitest";
import {
  builtInPrompt,
  comparePrompt,
  finalizePrompt,
  generatePrompt,
  mutatePrompt,
  PHASE_VARIABLES,
  validatePromptTemplate,
  type PromptPhase
} from "@deepthonk/core";

const sampleCandidate = (id: string, content: string) => ({
  id,
  generation: 0 as const,
  kind: "user-supplied" as const,
  content,
  metadata: { createdAt: "2026-05-18T00:00:00.000Z" }
});

describe("prompt variable substitution", () => {
  it("substitutes {task} and {rubric} in generate built-in", () => {
    const prompt = generatePrompt("Solve x^2=4", "Be precise.");
    expect(prompt.user).toContain("Solve x^2=4");
    expect(prompt.user).toContain("Be precise.");
    expect(prompt.user).not.toContain("{task}");
    expect(prompt.user).not.toContain("{rubric}");
  });

  it("renders all candidate variables in compare built-in", () => {
    const a = sampleCandidate("a", "ANSWER A");
    const b = sampleCandidate("b", "ANSWER B");
    const prompt = comparePrompt("T", a, b, "R");
    expect(prompt.user).toContain("ANSWER A");
    expect(prompt.user).toContain("ANSWER B");
    expect(prompt.user).toContain("T");
    expect(prompt.user).toContain("R");
  });

  it("preserves literal braces via {{ and }} escape in compare template", () => {
    const a = sampleCandidate("a", "x");
    const b = sampleCandidate("b", "y");
    const prompt = comparePrompt("T", a, b, "R");
    // The compare template includes a literal JSON object with { and } produced by {{ }}
    expect(prompt.user).toContain('"feedback_a"');
    expect(prompt.user).toContain('"winner": "A" | "B" | "tie"');
  });

  it("uses override.user template with variable substitution", () => {
    const prompt = generatePrompt("X", "Y", "general", {
      user: "ROLE: lawyer\nTASK: {task}\nRUBRIC: {rubric}"
    });
    expect(prompt.user).toBe("ROLE: lawyer\nTASK: X\nRUBRIC: Y");
  });

  it("falls back to built-in system when only user is overridden", () => {
    const prompt = generatePrompt("X", "Y", "general", { user: "Q: {task}" });
    expect(prompt.system).toContain("expert solver");
    expect(prompt.user).toBe("Q: X");
  });

  it("falls back to built-in user when only system is overridden", () => {
    const prompt = generatePrompt("X", "Y", "general", { system: "ROLE: judge" });
    expect(prompt.system).toBe("ROLE: judge");
    expect(prompt.user).toContain("TASK:\nX");
  });

  it("throws ConfigError on unknown variable in override", () => {
    expect(() =>
      generatePrompt("X", "Y", "general", { user: "Q: {candiate}" })
    ).toThrow(/Unknown template variable.*candiate/);
  });

  it("allows unknown-looking variable in built-in (no validation)", () => {
    // Built-in templates never contain unknown variables; this just confirms
    // validation does not run against built-ins.
    expect(() => generatePrompt("x", "y")).not.toThrow();
  });

  it("supports the candidate variable in mutate override", () => {
    const candidate = sampleCandidate("c1", "current code");
    const prompt = mutatePrompt("T", candidate, "fix the bug", "R", "general", {
      user: "Improve: {candidate}\nCritique: {critique}"
    });
    expect(prompt.user).toBe("Improve: current code\nCritique: fix the bug");
  });

  it("supports the candidate variable in finalize override", () => {
    const candidate = sampleCandidate("c1", "the winner");
    const prompt = finalizePrompt("T", candidate, "R", "general", {
      user: "Polish: {candidate}"
    });
    expect(prompt.user).toBe("Polish: the winner");
  });

  it("supports candidateA / candidateB in compare override", () => {
    const a = sampleCandidate("a", "A_TEXT");
    const b = sampleCandidate("b", "B_TEXT");
    const prompt = comparePrompt("T", a, b, "R", "general", {
      user: "Pick: A={candidateA} B={candidateB}"
    });
    expect(prompt.user).toBe("Pick: A=A_TEXT B=B_TEXT");
  });

  it("rejects {candidate} in compare phase (wrong variable for phase)", () => {
    const a = sampleCandidate("a", "x");
    const b = sampleCandidate("b", "y");
    expect(() =>
      comparePrompt("T", a, b, "R", "general", { user: "Pick: {candidate}" })
    ).toThrow(/Unknown template variable.*candidate.*in compare prompt/);
  });

  it("rejects {critique} in generate phase", () => {
    expect(() =>
      generatePrompt("X", "Y", "general", { user: "Try: {critique}" })
    ).toThrow(/Unknown template variable.*critique.*in generate prompt/);
  });

  it("paper-programming style picks the C++17 template family", () => {
    const prompt = generatePrompt("T", "R", "paper-programming");
    expect(prompt.user).toContain("C++17");
  });

  it("override on top of paper-programming style still substitutes variables", () => {
    const prompt = generatePrompt("X", "Y", "paper-programming", {
      user: "Solve in Rust: {task}"
    });
    expect(prompt.user).toBe("Solve in Rust: X");
  });

  it("validatePromptTemplate accepts allowed variables", () => {
    for (const [phase, vars] of Object.entries(PHASE_VARIABLES)) {
      const template = vars.map((v) => `{${v}}`).join(" ");
      expect(() => validatePromptTemplate(template, phase as PromptPhase)).not.toThrow();
    }
  });

  it("validatePromptTemplate treats {{ as a literal escape, not a variable", () => {
    expect(() => validatePromptTemplate("Use {{braces}} freely", "generate")).not.toThrow();
  });

  it("builtInPrompt exposes the templates with placeholders intact", () => {
    const built = builtInPrompt("generate", "general");
    expect(built.user).toContain("{task}");
    expect(built.user).toContain("{rubric}");
  });

  it("does not interpret $-sequences in variable values (regex value semantics)", () => {
    // String.replace's function form does not treat $-sequences specially in
    // the return value. This test pins that behavior so a future refactor to
    // the string-replacement form does not silently corrupt prompts that
    // contain $1, $&, $$, etc.
    const prompt = generatePrompt("Use $1 and $& and $$ literally.", "$reflect", "general", {
      user: "TASK: {task}\nRUBRIC: {rubric}"
    });
    expect(prompt.user).toBe("TASK: Use $1 and $& and $$ literally.\nRUBRIC: $reflect");
  });

  it("substitutes adjacent placeholders correctly", () => {
    const prompt = generatePrompt("X", "Y", "general", { user: "{task}{rubric}{task}" });
    expect(prompt.user).toBe("XYX");
  });

  it("preserves multi-byte unicode and emoji in variable values", () => {
    const prompt = generatePrompt("漢字 🎯 émoji ñ", "rúbrica", "general", { user: "T={task} R={rubric}" });
    expect(prompt.user).toBe("T=漢字 🎯 émoji ñ R=rúbrica");
  });
});
