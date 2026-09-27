import { describe, expect, it } from "vitest";
import { generateDisplayName, resolvePolicy } from "./index.js";

describe("generateDisplayName", () => {
  it("produces adjective-animal-number format", () => {
    const name = generateDisplayName(new Uint8Array([0, 0, 0, 0]));
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });
});

describe("resolvePolicy", () => {
  it("sets decryption deadline for time_limited", () => {
    const now = 1_000_000;
    const p = resolvePolicy("time_limited", undefined, now);
    expect(p.decryptionDeadlineAt).toBe(now + 60 * 60 * 1000);
  });

  it("marks one_time", () => {
    const p = resolvePolicy("one_time");
    expect(p.oneTime).toBe(true);
  });
});
