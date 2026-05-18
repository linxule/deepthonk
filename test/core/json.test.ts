import { describe, expect, it } from "vitest";
import { parseJsonObject } from "@deepthonk/core";

describe("parseJsonObject", () => {
  it("parses strict JSON", () => {
    expect(parseJsonObject('{"winner":"A"}')).toEqual({ winner: "A" });
  });

  it("extracts fenced JSON", () => {
    expect(parseJsonObject('```json\n{"winner":"tie"}\n```')).toEqual({ winner: "tie" });
  });

  it("rejects invalid output", () => {
    expect(() => parseJsonObject("nope")).toThrow(/valid JSON object/);
  });
});

