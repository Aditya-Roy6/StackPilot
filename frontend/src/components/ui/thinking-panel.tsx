"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useTheme } from "next-themes";
import { ThinkingOrb, type OrbState } from "thinking-orbs";

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
 * Accordion block displaying the model's thinking process and stats.
 * Positioned above the assistant's final response content.
 * Supports multiple thinking blocks (e.g. multi-step reasoning, tool diagnostics, synthesis thinking).
 */
export function ThinkingPanel({
  reasoning,
  stats,
  isGenerating,
  orbStyle = "solving",
  className,
}: {
  reasoning?: string | string[];
  stats?: ThinkingStats;
  isGenerating?: boolean;
  orbStyle?: OrbState | "off";
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (isGenerating && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [reasoning, isGenerating]);

  const rawBlocks = Array.isArray(reasoning)
    ? reasoning
    : typeof reasoning === "string"
    ? reasoning.split(/\n\s*---\s*\n/).map((b) => b.trim()).filter(Boolean)
    : [];

  const hasReasoning = rawBlocks.length > 0;
  const chips: string[] = [];

  if (stats?.latencyMs != null) chips.push(formatDuration(stats.latencyMs));
  if (stats?.totalTokens) {
    const parts =
      stats.promptTokens != null && stats.completionTokens != null
        ? ` (${compactNumber(stats.promptTokens)} in / ${compactNumber(stats.completionTokens)} out)`
        : "";
    chips.push(`${compactNumber(stats.totalTokens)} tokens${parts}`);
  }
  if (stats?.confidence != null && stats.confidence > 0) {
    chips.push(`${Math.round(stats.confidence * 100)}% confidence`);
  }

  if (!hasReasoning && chips.length === 0 && !isGenerating) return null;

  return (
    <div className={cn("mb-3 space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {(hasReasoning || isGenerating) && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground transition-colors"
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {isGenerating && orbStyle !== "off" && (
              <span className="inline-flex items-center transition-opacity duration-300">
                <ThinkingOrb state={orbStyle || "solving"} size={20} theme={isDark ? "dark" : "light"} />
              </span>
            )}
            <span>
              {isGenerating
                ? "Thinking..."
                : open
                ? `Hide thinking${rawBlocks.length > 1 ? ` (${rawBlocks.length} blocks)` : ""}`
                : `Show thinking${rawBlocks.length > 1 ? ` (${rawBlocks.length} blocks)` : ""}`}
            </span>
          </button>
        )}
        {chips.map((chip) => (
          <span key={chip}>{chip}</span>
        ))}
      </div>

      {open && hasReasoning && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            The model&apos;s working. This is not the answer, and it is often wrong on the way to being right.
          </p>

          {rawBlocks.length === 1 ? (
            <pre
              ref={preRef}
              className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground"
            >
              {rawBlocks[0]}
            </pre>
          ) : (
            <div className="space-y-2.5">
              {rawBlocks.map((block, idx) => (
                <div key={idx} className="rounded-md border border-border/60 bg-background/60 p-2.5">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
                    <Sparkles className="h-3 w-3 text-amber-500" />
                    <span>Thinking Block {idx + 1}</span>
                  </div>
                  <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                    {block}
                  </pre>
                </div>
              ))}
            </div>
          )}

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
