import { describe, expect, it } from "vitest";

import { normalizeColor, withAlpha } from "./canvas-theme";

/**
 * jsdom's canvas has no real 2D context, so these tests drive the two pure
 * helpers with a stub that reproduces the one browser behaviour they rely on:
 * assigning an unparseable colour to `fillStyle` is a silent no-op.
 */
function stubContext(parse: (value: string) => string | null) {
  let current = "#000000";
  return {
    get fillStyle() {
      return current;
    },
    set fillStyle(value: string) {
      const parsed = parse(value);
      if (parsed !== null) current = parsed;
    },
  };
}

/** Recognises the handful of forms the themes actually produce. */
const browserish = stubContext((value) => {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (v === "oklch(0.145 0 0)") return "#252525";
  if (v === "white") return "#ffffff";
  if (v.startsWith("rgba(")) return v;
  return null;
});

describe("normalizeColor", () => {
  it("passes a hex colour through", () => {
    expect(normalizeColor(browserish, "#123456", "#ffffff")).toBe("#123456");
  });

  it("converts a colour space the canvas understands but we cannot parse", () => {
    // The themes are written in oklch(); nothing downstream should have to
    // know that.
    expect(normalizeColor(browserish, "oklch(0.145 0 0)", "#ffffff")).toBe("#252525");
  });

  it("falls back when the variable resolves to an empty string", () => {
    // getPropertyValue returns "" for a variable that is not defined, which is
    // exactly what happens if a theme forgets a token.
    expect(normalizeColor(browserish, "", "#abcdef")).toBe("#abcdef");
    expect(normalizeColor(browserish, "   ", "#abcdef")).toBe("#abcdef");
  });

  it("falls back when the value is unparseable rather than keeping the last colour", () => {
    // This is the failure mode the seeding guards against: without it, an
    // invalid value would silently inherit whatever was drawn previously.
    browserish.fillStyle = "#ff0000";
    expect(normalizeColor(browserish, "not-a-colour", "#00ff00")).toBe("#00ff00");
  });

  it("tolerates surrounding whitespace, which getPropertyValue leaves in", () => {
    expect(normalizeColor(browserish, "  #123456  ", "#ffffff")).toBe("#123456");
  });
});

describe("withAlpha", () => {
  it("expands a hex colour into rgba", () => {
    expect(withAlpha("#000000", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
    expect(withAlpha("#ffffff", 1)).toBe("rgba(255, 255, 255, 1)");
  });

  it("splits the channels correctly", () => {
    expect(withAlpha("#12345a", 0.25)).toBe("rgba(18, 52, 90, 0.25)");
  });

  it("is case insensitive", () => {
    expect(withAlpha("#AABBCC", 0.5)).toBe("rgba(170, 187, 204, 0.5)");
  });

  it("returns non-hex input untouched", () => {
    // The fallbacks are already rgba(...) strings; passing one through must not
    // corrupt it.
    expect(withAlpha("rgba(1, 2, 3, 0.4)", 0.9)).toBe("rgba(1, 2, 3, 0.4)");
    expect(withAlpha("#abc", 0.5)).toBe("#abc");
  });
});
