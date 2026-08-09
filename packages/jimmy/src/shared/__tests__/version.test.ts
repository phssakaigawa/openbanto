import { describe, expect, it } from "vitest";
import { compareSemver, isDottedNumericVersion } from "../version.js";

describe("version utilities", () => {
  it("accepts historical semver-like versions and OpenRyoko CalVer versions", () => {
    expect(isDottedNumericVersion("0.9.0")).toBe(true);
    expect(isDottedNumericVersion("2026.5.7")).toBe(true);
    expect(isDottedNumericVersion("2026.5")).toBe(false);
    expect(isDottedNumericVersion("2026.05.07-beta")).toBe(false);
  });

  it("orders CalVer versions numerically by year, month, then day", () => {
    expect(compareSemver("2026.10.1", "2026.4.30")).toBeGreaterThan(0);
    expect(compareSemver("2026.5.7", "2026.5.13")).toBeLessThan(0);
    expect(compareSemver("2026.5.13", "0.9.0")).toBeGreaterThan(0);
  });
});
