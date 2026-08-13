import { describe, expect, it } from "vitest";

import verbData from "./status-verbs.json";
import {
  allVerbs,
  categorize,
  isSoberCategory,
  pickVerb,
  pickVerbSequence,
} from "./status-verbs";

// A fixed sequence standing in for Math.random, so every assertion below is
// deterministic. Cycles rather than running out.
const seeded = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe("the verb catalogue", () => {
  it("has enough verbs to not feel repetitive", () => {
    expect(allVerbs().length).toBeGreaterThanOrEqual(180);
  });

  it("has no duplicates within a category", () => {
    for (const [name, entry] of Object.entries(verbData.categories)) {
      const verbs = (entry as { verbs: string[] }).verbs;
      expect(new Set(verbs).size, `${name} has repeats`).toBe(verbs.length);
    }
  });

  it("has no empty or whitespace-only verbs", () => {
    for (const verb of allVerbs()) {
      expect(verb.trim()).not.toBe("");
    }
  });

  it("never ends a verb with an ellipsis", () => {
    // The component appends the "…" itself; a verb carrying its own would
    // render "Thinking……".
    for (const verb of allVerbs()) {
      expect(verb.endsWith("."), verb).toBe(false);
      expect(verb.endsWith("…"), verb).toBe(false);
    }
  });

  it("keeps every verb short enough not to reflow the line", () => {
    for (const verb of allVerbs()) {
      expect(verb.length, verb).toBeLessThanOrEqual(34);
    }
  });

  it("gives every category at least one verb", () => {
    for (const [name, entry] of Object.entries(verbData.categories)) {
      expect((entry as { verbs: string[] }).verbs.length, name).toBeGreaterThan(0);
    }
  });
});

describe("categorize", () => {
  it("routes a broken deployment to diagnose", () => {
    expect(categorize("why did my deployment fail")).toBe("diagnose");
    expect(categorize("the container keeps crashing")).toBe("diagnose");
    expect(categorize("build is stuck")).toBe("diagnose");
  });

  it("routes a deploy request to deploy", () => {
    expect(categorize("deploy portfolio-new to production")).toBe("deploy");
    expect(categorize("scale the api to 3 replicas")).toBe("deploy");
  });

  it("routes credential questions to secrets", () => {
    expect(categorize("where is the database password")).toBe("secrets");
    expect(categorize("rotate the api key")).toBe("secrets");
  });

  it("falls back to generic when nothing matches", () => {
    expect(categorize("hello")).toBe("generic");
    expect(categorize("")).toBe("generic");
  });

  it("is case insensitive", () => {
    expect(categorize("WHY DID THIS FAIL")).toBe("diagnose");
  });

  it("prefers the longer, more specific phrase", () => {
    // "not working" is a diagnose phrase and must win over any shorter match
    // that happens to also appear in the sentence.
    expect(categorize("the deploy is not working")).toBe("diagnose");
  });

  it("lets intent beat the noun", () => {
    // The bug this pins: ranking purely by phrase length classified
    // "why did the deployment crash" as a *deploy*, because "deployment"
    // contains the six-letter "deploy" and outranked the five-letter "crash".
    // Someone staring at a crash loop then got a cheerful rollout verb.
    expect(categorize("why did the deployment crash")).toBe("diagnose");
    expect(categorize("the release failed")).toBe("diagnose");
    expect(categorize("my build is broken")).toBe("diagnose");
    // And a credential mention pulls the tone flat whatever else is going on.
    expect(categorize("deploy the app with the new api key")).toBe("secrets");
  });
});

describe("pickVerb", () => {
  it("returns a verb that exists in the catalogue", () => {
    const catalogue = new Set(allVerbs());
    for (let i = 0; i < 200; i += 1) {
      expect(catalogue.has(pickVerb("deploy the app"))).toBe(true);
    }
  });

  it("never returns a playful verb for a broken deployment", () => {
    // The rule that matters. "Noodling…" while someone stares at a crash loop
    // reads as the system not understanding the situation.
    const diagnoseVerbs = new Set(verbData.categories.diagnose.verbs);
    for (let i = 0; i < 300; i += 1) {
      const verb = pickVerb("why did the deployment crash");
      expect(diagnoseVerbs.has(verb), `leaked: ${verb}`).toBe(true);
    }
  });

  it("never leaks playful verbs into secrets prompts either", () => {
    const secretVerbs = new Set(verbData.categories.secrets.verbs);
    for (let i = 0; i < 300; i += 1) {
      expect(secretVerbs.has(pickVerb("show me the database password"))).toBe(true);
    }
  });

  it("does blend generic verbs into non-sober categories", () => {
    // Blending is what stops a category of 25 words feeling like a loop.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(pickVerb("deploy the app"));
    }
    const genericVerbs = new Set(verbData.categories.generic.verbs);
    const blended = [...seen].some((verb) => genericVerbs.has(verb));
    expect(blended).toBe(true);
  });

  it("marks exactly the categories that must stay flat", () => {
    expect(isSoberCategory("diagnose")).toBe(true);
    expect(isSoberCategory("secrets")).toBe(true);
    expect(isSoberCategory("generic")).toBe(false);
    expect(isSoberCategory("build")).toBe(false);
  });

  it("does not run off the end when random returns its maximum", () => {
    // Math.random() is [0, 1), but an injected or mocked source may not be.
    // Indexing past the end would render "undefined…".
    expect(pickVerb("deploy", seeded([0.999999]))).toBeTruthy();
    expect(pickVerb("deploy", seeded([1]))).toBeTruthy();
    expect(pickVerb("hello", seeded([1]))).toBeTruthy();
  });

  it("is deterministic for a fixed random source", () => {
    const first = pickVerb("explain how builds work", seeded([0.5, 0.5]));
    const second = pickVerb("explain how builds work", seeded([0.5, 0.5]));
    expect(first).toBe(second);
  });
});

describe("pickVerbSequence", () => {
  it("returns the requested number of verbs", () => {
    expect(pickVerbSequence("deploy the app", 12)).toHaveLength(12);
  });

  it("never repeats the immediately preceding verb", () => {
    // Two identical words in a row is exactly what makes a rotating indicator
    // look frozen, which is the thing it exists to disprove.
    const sequence = pickVerbSequence("why did this fail", 40);
    for (let i = 1; i < sequence.length; i += 1) {
      expect(sequence[i], `repeat at ${i}`).not.toBe(sequence[i - 1]);
    }
  });

  it("terminates even when the random source always returns the same value", () => {
    // The guard against an infinite loop: a degenerate source would otherwise
    // propose the same verb forever and hang the render.
    const sequence = pickVerbSequence("deploy", 8, () => 0);
    expect(sequence).toHaveLength(8);
    expect(sequence.every((verb) => typeof verb === "string" && verb.length > 0)).toBe(true);
  });

  it("handles a request for a single verb", () => {
    expect(pickVerbSequence("hello", 1)).toHaveLength(1);
  });

  it("handles a request for zero verbs", () => {
    expect(pickVerbSequence("hello", 0)).toHaveLength(0);
  });
});
