"use client";

import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ThinkingStats {
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  confidence?: number;
  model?: string;
  provider?: string;
  traceId?: string;
}

/** 1234 -> "1.2k". Token counts get long and the exact digit rarely matters. */
function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/**
 * Collapsed by default, on purpose. Reasoning is long, and a reply that opens
 * with 400 words of the model talking to itself buries the answer. It is one
 * click away for when the answer looks wrong and you want to see where it went
 * astray -- which is the case it exists for.
 */
export function ThinkingPanel({
  reasoning,
  stats,
  className,
}: {
  reasoning?: string;
  stats?: ThinkingStats;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const hasReasoning = Boolean(reasoning && reasoning.trim());
  const chips: string[] = [];

  if (stats?.latencyMs != null) chips.push(formatDuration(stats.latencyMs));
  if (stats?.totalTokens) {
    // Prompt and completion split matters: a huge prompt with a tiny answer is
    // a context problem, not a model problem.
    const parts =
      stats.promptTokens != null && stats.completionTokens != null
        ? ` (${compactNumber(stats.promptTokens)} in / ${compactNumber(stats.completionTokens)} out)`
        : "";
    chips.push(`${compactNumber(stats.totalTokens)} tokens${parts}`);
  }
  if (stats?.confidence != null && stats.confidence > 0) {
    chips.push(`${Math.round(stats.confidence * 100)}% confidence`);
  }

  if (!hasReasoning && chips.length === 0) return null;

  return (
    <div className={cn("mt-2 space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {hasReasoning && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Brain className="h-3 w-3" />
            {open ? "Hide thinking" : "Show thinking"}
          </button>
        )}
        {chips.map((chip) => (
          <span key={chip}>{chip}</span>
        ))}
      </div>

      {open && hasReasoning && (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            The model&apos;s working. This is not the answer, and it is often
            wrong on the way to being right.
          </p>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
            {reasoning}
          </pre>
          {stats?.traceId && (
            <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
              trace {stats.traceId}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
