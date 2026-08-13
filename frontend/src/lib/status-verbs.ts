import verbData from "./status-verbs.json";

/**
 * Picks the word shown while the agent is working, based on what was asked.
 *
 * The selection is deliberately not uniform over every verb. A prompt about a
 * crashed deployment should not be answered with "Noodling..." — matching the
 * category first, then choosing within it, is what keeps the tone honest.
 *
 * Everything here is pure and seedable so it can be tested. Randomness that
 * cannot be pinned is randomness nobody verifies.
 */

type Category = {
  match: string[];
  verbs: string[];
};

const CATEGORIES = verbData.categories as unknown as Record<string, Category>;

export type StatusCategory = keyof typeof verbData.categories;

/** Chance of reaching for a generic verb even when a category matched. */
const GENERIC_BLEND = 0.25;

/**
 * Categories whose tone must stay flat. A prompt about a broken deployment or
 * a credential is not the place for whimsy — it reads as the system not
 * understanding the situation.
 */
const SOBER: ReadonlySet<string> = new Set(["diagnose", "secrets"]);

export function isSoberCategory(category: string): boolean {
  return SOBER.has(category);
}

/** Every verb across every category, for tests and for tooling. */
export function allVerbs(): string[] {
  return Object.values(CATEGORIES).flatMap((entry) => entry.verbs);
}

/**
 * Classifies a prompt. Longer match phrases win over shorter ones, so
 * "not working" beats a bare "work", and specific beats general.
 */
export function categorize(prompt: string): StatusCategory {
  const text = prompt.toLowerCase();

  const matchIn = (names: string[]): string | null => {
    let best: { category: string; length: number } | null = null;
    for (const name of names) {
      for (const phrase of CATEGORIES[name]?.match ?? []) {
        if (!text.includes(phrase)) continue;
        if (!best || phrase.length > best.length) {
          best = { category: name, length: phrase.length };
        }
      }
    }
    return best?.category ?? null;
  };

  // Sober categories are checked first and win outright, rather than competing
  // on phrase length with everything else.
  //
  // "why did the deployment crash" is a diagnosis, not a deploy: the noun is
  // "deployment" but the intent is "something is broken". Length-ranking got
  // this wrong, because "deployment" contains the six-letter "deploy" and beat
  // the five-letter "crash" — so a question asked while staring at a crash
  // loop was answered with a cheerful rollout verb.
  //
  // The same reasoning covers credentials: any mention of a secret should pull
  // the tone flat regardless of what else the sentence is about.
  const sober = matchIn([...SOBER]);
  if (sober) return sober as StatusCategory;

  const rest = Object.keys(CATEGORIES).filter((name) => !SOBER.has(name));
  return (matchIn(rest) ?? "generic") as StatusCategory;
}

/**
 * Picks a verb for a prompt. `random` is injectable so tests can pin the
 * outcome; it must return a value in [0, 1).
 */
export function pickVerb(prompt: string, random: () => number = Math.random): string {
  const category = categorize(prompt);
  const categoryVerbs = CATEGORIES[category]?.verbs ?? [];
  const genericVerbs = CATEGORIES.generic.verbs;

  // Sober categories never blend in the playful generic pool, and a prompt
  // that matched nothing is already generic.
  const useGeneric =
    category === "generic" ||
    (!isSoberCategory(category) && random() < GENERIC_BLEND) ||
    categoryVerbs.length === 0;

  const pool = useGeneric ? genericVerbs : categoryVerbs;
  const index = Math.floor(random() * pool.length);
  // Guard the boundary: a random() of exactly 1 would index past the end.
  return pool[Math.min(index, pool.length - 1)];
}

/**
 * A sequence of distinct verbs for one request, so a long wait cycles through
 * words instead of sitting on one. Falls back to repeating only if the
 * category is smaller than the requested count.
 */
export function pickVerbSequence(
  prompt: string,
  count: number,
  random: () => number = Math.random
): string[] {
  const sequence: string[] = [];
  let guard = 0;
  while (sequence.length < count && guard < count * 20) {
    const verb = pickVerb(prompt, random);
    // Never repeat the immediately preceding word — that is what makes a
    // rotating indicator look frozen.
    if (sequence[sequence.length - 1] !== verb) {
      sequence.push(verb);
    }
    guard += 1;
  }
  while (sequence.length < count) {
    sequence.push(sequence[sequence.length % Math.max(1, sequence.length)] ?? "Working");
  }
  return sequence;
}
