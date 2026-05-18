import { JsonParseError } from "./errors.js";

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, extractFence(trimmed), extractBalancedObject(trimmed)].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next extraction strategy.
    }
  }
  throw new JsonParseError("Model output did not contain a valid JSON object.");
}

function extractFence(text: string): string | undefined {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim();
}

function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

