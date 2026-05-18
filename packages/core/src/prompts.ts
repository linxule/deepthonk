import { ConfigError } from "./errors.js";
import type { Candidate, PromptMessages, PromptOverride } from "./schemas.js";

const defaultRubric = "Prefer answers that are correct, complete, robust, verifiable, and directly aligned with the task.";
const codeRubric = "The solution should be correct, efficient, and accepted under standard competitive-programming constraints.";
const codeJudgeRubric = "Judge correctness, edge cases, algorithmic complexity, and implementation robustness.";

export type PromptStyle = "general" | "paper-programming";
export type PromptPhase = "generate" | "compare" | "mutate" | "finalize";

export const PHASE_VARIABLES: Record<PromptPhase, readonly string[]> = {
  generate: ["task", "rubric"],
  compare: ["task", "rubric", "candidateA", "candidateB"],
  mutate: ["task", "rubric", "candidate", "critique"],
  finalize: ["task", "rubric", "candidate"]
} as const;

interface PhaseTemplate {
  system: string;
  user: string;
}

const TEMPLATES: Record<PromptStyle, Record<PromptPhase, PhaseTemplate>> = {
  general: {
    generate: {
      system:
        "You are an expert solver. Produce the best answer you can.\nDo not include hidden chain-of-thought. You may include concise justification only when useful.\nReturn the final answer/artifact directly.",
      user: "TASK:\n{task}\n\nRUBRIC:\n{rubric}\n\nProduce one complete candidate answer."
    },
    compare: {
      system: "",
      user: `You are a strict pairwise judge. Compare two candidate answers for the given task.
Select the candidate more likely to be correct, complete, robust, and aligned with the rubric.
Declare a tie only when neither candidate is clearly better. Do not rely on position.
Do not give hidden chain-of-thought. Return strict JSON only.

TASK:
{task}

RUBRIC:
{rubric}

SOLUTION A:
{candidateA}

SOLUTION B:
{candidateB}

Return JSON with exactly this shape:
{{
  "feedback_a": "specific feedback for Solution A",
  "feedback_b": "specific feedback for Solution B",
  "winner": "A" | "B" | "tie"
}}`
    },
    mutate: {
      system:
        "You are an expert solver improving a candidate answer using critique from pairwise comparisons.\nYou may either refine the current approach or abandon it and produce a fundamentally different solution.\nDo not include hidden chain-of-thought. Return the complete improved candidate answer.",
      user: "TASK:\n{task}\n\nRUBRIC:\n{rubric}\n\nCURRENT CANDIDATE:\n{candidate}\n\nAGGREGATED CRITIQUE:\n{critique}\n\nProduce one complete improved candidate answer."
    },
    finalize: {
      system:
        "You are preparing the winning candidate for final delivery.\nPreserve correctness. Remove obvious duplication. Do not add unsupported claims.\nReturn the final answer only.",
      user: "TASK:\n{task}\n\nRUBRIC:\n{rubric}\n\nWINNING CANDIDATE:\n{candidate}"
    }
  },
  "paper-programming": {
    generate: {
      system: "",
      user: `You are an expert competitive programmer. Solve the programming problem below.
Provide a brief explanation, then provide a complete accepted C++17 solution in one code block.
Do not include hidden chain-of-thought.

PROBLEM:
{task}

RUBRIC:
{rubric}`
    },
    compare: {
      system: "",
      user: `You are judging two proposed competitive-programming solutions.
Prefer the solution more likely to receive an Accepted verdict. If both are wrong, choose the one requiring fewer modifications to become accepted. Declare a tie only when neither is clearly better.
Do not give hidden chain-of-thought. Return strict JSON only.

PROBLEM:
{task}

RUBRIC:
{rubric}

SOLUTION A:
{candidateA}

SOLUTION B:
{candidateB}

Return JSON with exactly this shape:
{{
  "feedback_a": "specific feedback for Solution A",
  "feedback_b": "specific feedback for Solution B",
  "winner": "A" | "B" | "tie"
}}`
    },
    mutate: {
      system: "",
      user: `You are an expert competitive programmer improving a proposed solution using feedback from pairwise judging.
You may refine the current approach or abandon it and use a fundamentally different approach.
Provide a brief explanation, then provide a complete accepted C++17 solution in one code block.
Do not include hidden chain-of-thought.

PROBLEM:
{task}

RUBRIC:
{rubric}

CURRENT SOLUTION:
{candidate}

AGGREGATED FEEDBACK:
{critique}`
    },
    finalize: {
      system:
        "You are preparing the winning candidate for final delivery.\nPreserve correctness. Remove obvious duplication. Do not add unsupported claims.\nReturn the final answer only.",
      user: "TASK:\n{task}\n\nRUBRIC:\n{rubric}\n\nWINNING CANDIDATE:\n{candidate}"
    }
  }
};

function defaultRubricFor(phase: PromptPhase, style: PromptStyle): string {
  if (style === "paper-programming") {
    if (phase === "compare") return codeJudgeRubric;
    if (phase === "generate" || phase === "mutate") return codeRubric;
  }
  return defaultRubric;
}

export function builtInPrompt(phase: PromptPhase, style: PromptStyle): PhaseTemplate {
  const phaseStyle = TEMPLATES[style] ?? TEMPLATES.general;
  return phaseStyle[phase];
}

export function validatePromptTemplate(template: string, phase: PromptPhase): void {
  const allowed = new Set(PHASE_VARIABLES[phase]);
  for (const variable of extractVariables(template)) {
    if (!allowed.has(variable)) {
      throw new ConfigError(
        `Unknown template variable "{${variable}}" in ${phase} prompt. Available: ${PHASE_VARIABLES[phase]
          .map((value) => `{${value}}`)
          .join(", ")}. Use {{ and }} to escape literal braces.`,
        { code: "prompts.unknown_variable", retryable: false, fix: "Remove the variable or use a supported one." }
      );
    }
  }
}

function extractVariables(template: string): string[] {
  const names: string[] = [];
  template.replace(/\{\{|\}\}|\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name?: string) => {
    if (name) names.push(name);
    return "";
  });
  return names;
}

function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{|\}\}|\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name?: string) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (name && Object.prototype.hasOwnProperty.call(variables, name)) return variables[name];
    return match;
  });
}

function renderPhase(
  phase: PromptPhase,
  style: PromptStyle,
  override: PromptOverride | undefined,
  variables: Record<string, string>
): PromptMessages {
  const builtIn = builtInPrompt(phase, style);
  const systemTemplate = override?.system ?? builtIn.system;
  const userTemplate = override?.user ?? builtIn.user;
  if (override?.system !== undefined) validatePromptTemplate(systemTemplate, phase);
  if (override?.user !== undefined) validatePromptTemplate(userTemplate, phase);
  return {
    system: substituteVariables(systemTemplate, variables),
    user: substituteVariables(userTemplate, variables)
  };
}

export function generatePrompt(
  task: string,
  rubric?: string,
  style: PromptStyle = "general",
  override?: PromptOverride
): PromptMessages {
  return renderPhase("generate", style, override, {
    task,
    rubric: rubric ?? defaultRubricFor("generate", style)
  });
}

export function comparePrompt(
  task: string,
  candidateA: Candidate,
  candidateB: Candidate,
  rubric?: string,
  style: PromptStyle = "general",
  override?: PromptOverride
): PromptMessages {
  return renderPhase("compare", style, override, {
    task,
    rubric: rubric ?? defaultRubricFor("compare", style),
    candidateA: candidateA.content,
    candidateB: candidateB.content
  });
}

export function mutatePrompt(
  task: string,
  candidate: Candidate,
  critique: string,
  rubric?: string,
  style: PromptStyle = "general",
  override?: PromptOverride
): PromptMessages {
  return renderPhase("mutate", style, override, {
    task,
    rubric: rubric ?? defaultRubricFor("mutate", style),
    candidate: candidate.content,
    critique
  });
}

export function finalizePrompt(
  task: string,
  candidate: Candidate,
  rubric?: string,
  style: PromptStyle = "general",
  override?: PromptOverride
): PromptMessages {
  return renderPhase("finalize", style, override, {
    task,
    rubric: rubric ?? defaultRubricFor("finalize", style),
    candidate: candidate.content
  });
}
