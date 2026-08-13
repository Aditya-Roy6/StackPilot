import { describe, expect, it } from "vitest";

import { cn } from "./utils";

// cn() is tailwind-merge over clsx. Every component's conditional styling
// depends on the *later* conflicting class winning; if that ever stops being
// true, variant props stop overriding base styles and the failure looks like
// a CSS problem rather than a JS one.

describe("cn", () => {
  it("joins plain class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values", () => {
    expect(cn("a", false && "b", null, undefined, "")).toBe("a");
  });

  it("lets the last conflicting Tailwind utility win", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  it("keeps non-conflicting utilities from the same family", () => {
    expect(cn("px-2", "py-4")).toBe("px-2 py-4");
  });

  it("resolves a variant override against a base class", () => {
    // The exact pattern every component uses: cn(baseStyles, props.className)
    expect(cn("rounded-md bg-primary", "bg-destructive")).toBe(
      "rounded-md bg-destructive"
    );
  });

  it("accepts arrays and conditional objects", () => {
    expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
  });

  it("returns an empty string for no input", () => {
    expect(cn()).toBe("");
  });
});
