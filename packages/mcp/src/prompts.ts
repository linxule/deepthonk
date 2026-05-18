import { comparePrompt, finalizePrompt, generatePrompt, mutatePrompt, type Candidate } from "@deepthonk/core";

export const promptNames = ["deepthonk/generate", "deepthonk/compare", "deepthonk/mutate", "deepthonk/finalize"] as const;

export function renderPrompt(name: string, args: Record<string, string>): string {
  const candidate = (id: string, content: string): Candidate => ({
    id,
    generation: 0,
    kind: "user-supplied",
    content,
    metadata: { createdAt: new Date().toISOString() }
  });
  const task = args.task ?? "";
  const rubric = args.rubric;
  if (name === "deepthonk/generate") return format(generatePrompt(task, rubric));
  if (name === "deepthonk/compare") return format(comparePrompt(task, candidate("A", args.candidateA ?? ""), candidate("B", args.candidateB ?? ""), rubric));
  if (name === "deepthonk/mutate") return format(mutatePrompt(task, candidate("candidate", args.candidate ?? ""), args.critique ?? "", rubric));
  if (name === "deepthonk/finalize") return format(finalizePrompt(task, candidate("winner", args.candidate ?? ""), rubric));
  throw new Error(`Unknown prompt: ${name}`);
}

function format(prompt: { system: string; user: string }): string {
  return `SYSTEM:\n${prompt.system}\n\nUSER:\n${prompt.user}`;
}

