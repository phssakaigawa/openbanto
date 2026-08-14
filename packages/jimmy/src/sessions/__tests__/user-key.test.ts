import { describe, it, expect } from "vitest";
import { userKey } from "../context.js";

describe("userKey — filesystem-safe speaker key derivation", () => {
  it("prefers the Slack ID over the display name", () => {
    expect(userKey({ speakerSlackId: "U12345", speakerName: "Sakaigawa さん" })).toBe("u12345");
  });

  it("falls back to a normalized display name when no Slack ID", () => {
    expect(userKey({ speakerName: "Shoichiro Sakaigawa" })).toBe("shoichiro-sakaigawa");
  });

  it("drops characters outside [a-z0-9_-] and collapses runs", () => {
    // Japanese + punctuation → stripped; ascii kept, kebabbed.
    expect(userKey({ speakerName: "境川 (Sakaigawa)!!" })).toBe("sakaigawa");
    expect(userKey({ speakerName: "a__b--c" })).toBe("a__b--c");
  });

  it("returns 'unknown' for empty / all-stripped / missing input", () => {
    expect(userKey({})).toBe("unknown");
    expect(userKey(undefined)).toBe("unknown");
    expect(userKey({ speakerName: "境川" })).toBe("unknown"); // all non-ascii
    expect(userKey({ speakerSlackId: "   " })).toBe("unknown");
  });

  it("never yields a leading/trailing dash", () => {
    const k = userKey({ speakerName: "  --Weird--  " });
    expect(k).not.toMatch(/^-|-$/);
  });
});
