import { JsonParseError } from "@deepthonk/core";

export const MAX_EXTRACTION_BYTES = 131_072;

export function extractJsonObjectText(text: string): string {
  if (text.length > MAX_EXTRACTION_BYTES) {
    throw new JsonParseError(`Response text exceeds ${MAX_EXTRACTION_BYTES}-byte JSON extraction cap; refusing to parse.`);
  }
  const trimmed = text.trim();
  const candidates = [trimmed, extractFence(trimmed), extractBalancedObject(trimmed)].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return candidate;
    } catch {
      // Try the next extraction strategy.
    }
  }
  throw new JsonParseError("Model output did not contain a valid JSON object.");
}

export function extractJsonObject(text: string): unknown {
  return JSON.parse(extractJsonObjectText(text));
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
