"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { pickVerbSequence } from "@/lib/status-verbs";

/**
 * The "Thinking…" indicator: a status verb chosen from the prompt, cycling on
 * a timer with a shine sweeping across the letters.
 *
 * The rotation is the point. A single static word looks identical whether the
 * request is progressing or wedged; a word that changes says the client is
 * still alive even when there is nothing new to report.
 */
export function StatusVerb({
  prompt,
  className,
  intervalMs = 2400,
}: {
  prompt: string;
  className?: string;
  intervalMs?: number;
}) {
  // Chosen once per request, not per render, so React re-renders do not
  // reshuffle the word mid-animation.
  const [sequence] = useState(() => pickVerbSequence(prompt, 12));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (sequence.length <= 1) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % sequence.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [sequence.length, intervalMs]);

  const verb = sequence[index] ?? "Working";

  return (
    <span
      className={cn("inline-flex items-baseline gap-1", className)}
      // One live region for the whole indicator. Without this a screen reader
      // announces every rotation, which turns a decorative timer into a
      // stream of interruptions.
      aria-live="polite"
      aria-label="Agent is working"
    >
      <span key={verb} className="status-verb-shine">
        {verb}
      </span>
      <span aria-hidden="true">…</span>
    </span>
  );
}
