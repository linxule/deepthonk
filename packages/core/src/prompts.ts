import type { Candidate, PromptMessages } from "./schemas.js";

const defaultRubric = "Prefer answers that are correct, complete, robust, verifiable, and directly aligned with the task.";
type PromptStyle = "general" | "paper-programming";

export function generatePrompt(task: string, rubric?: string, style: PromptStyle = "general"): PromptMessages {
  if (style === "paper-programming") {
    return {
      system: "",
      user: `You are an expert competitive programmer. Solve the programming problem below.
Provide a brief explanation, then provide a complete accepted C++17 solution in one code block.
Do not include hidden chain-of-thought.

PROBLEM:
${task}

RUBRIC:
${rubric ?? "The solution should be correct, efficient, and accepted under standard competitive-programming constraints."}`
    };
  }
  return {
    system:
      "You are an expert solver. Produce the best answer you can.\nDo not include hidden chain-of-thought. You may include concise justification only when useful.\nReturn the final answer/artifact directly.",
    user: `TASK:\n${task}\n\nRUBRIC:\n${rubric ?? defaultRubric}\n\nProduce one complete candidate answer.`
  };
}

export function comparePrompt(task: string, candidateA: Candidate, candidateB: Candidate, rubric?: string, style: PromptStyle = "general"): PromptMessages {
  if (style === "paper-programming") {
    return {
      system: "",
      user: `You are judging two proposed competitive-programming solutions.
Prefer the solution more likely to receive an Accepted verdict. If both are wrong, choose the one requiring fewer modifications to become accepted. Declare a tie only when neither is clearly better.
Do not give hidden chain-of-thought. Return strict JSON only.

PROBLEM:
${task}

RUBRIC:
${rubric ?? "Judge correctness, edge cases, algorithmic complexity, and implementation robustness."}

SOLUTION A:
${candidateA.content}

SOLUTION B:
${candidateB.content}

Return JSON with exactly this shape:
{
  "feedback_a": "specific feedback for Solution A",
  "feedback_b": "specific feedback for Solution B",
  "winner": "A" | "B" | "tie"
}`
    };
  }
  return {
    system: "",
    user: `You are a strict pairwise judge. Compare two candidate answers for the given task.
Select the candidate more likely to be correct, complete, robust, and aligned with the rubric.
Declare a tie only when neither candidate is clearly better. Do not rely on position.
Do not give hidden chain-of-thought. Return strict JSON only.

TASK:
${task}

RUBRIC:
${rubric ?? defaultRubric}

SOLUTION A:
${candidateA.content}

SOLUTION B:
${candidateB.content}

Return JSON with exactly this shape:
{
  "feedback_a": "specific feedback for Solution A",
  "feedback_b": "specific feedback for Solution B",
  "winner": "A" | "B" | "tie"
}`
  };
}

export function mutatePrompt(task: string, candidate: Candidate, critique: string, rubric?: string, style: PromptStyle = "general"): PromptMessages {
  if (style === "paper-programming") {
    return {
      system: "",
      user: `You are an expert competitive programmer improving a proposed solution using feedback from pairwise judging.
You may refine the current approach or abandon it and use a fundamentally different approach.
Provide a brief explanation, then provide a complete accepted C++17 solution in one code block.
Do not include hidden chain-of-thought.

PROBLEM:
${task}

RUBRIC:
${rubric ?? "The solution should be correct, efficient, and accepted under standard competitive-programming constraints."}

CURRENT SOLUTION:
${candidate.content}

AGGREGATED FEEDBACK:
${critique}`
    };
  }
  return {
    system:
      "You are an expert solver improving a candidate answer using critique from pairwise comparisons.\nYou may either refine the current approach or abandon it and produce a fundamentally different solution.\nDo not include hidden chain-of-thought. Return the complete improved candidate answer.",
    user: `TASK:\n${task}\n\nRUBRIC:\n${rubric ?? defaultRubric}\n\nCURRENT CANDIDATE:\n${candidate.content}\n\nAGGREGATED CRITIQUE:\n${critique}\n\nProduce one complete improved candidate answer.`
  };
}

export function finalizePrompt(task: string, candidate: Candidate, rubric?: string): PromptMessages {
  return {
    system:
      "You are preparing the winning candidate for final delivery.\nPreserve correctness. Remove obvious duplication. Do not add unsupported claims.\nReturn the final answer only.",
    user: `TASK:\n${task}\n\nRUBRIC:\n${rubric ?? defaultRubric}\n\nWINNING CANDIDATE:\n${candidate.content}`
  };
}
