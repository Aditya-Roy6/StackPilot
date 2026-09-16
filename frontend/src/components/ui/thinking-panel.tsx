"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useTheme } from "next-themes";
import { ThinkingOrb, type OrbState } from "thinking-orbs";

import { cn } from "@/lib/utils";
import { AnimatedMarkdown } from "@/components/ui/animated-markdown";
import { AnimatedStreamingText } from "@/components/ui/animated-streaming-text";

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
  const preRef = useRef<HTMLDivElement>(null);

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

  const isExpanded = open && hasReasoning;

  return (
    <div className={cn("transition-[margin] duration-200", isExpanded ? "mb-2.5 space-y-1.5" : "mb-0 space-y-0", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
        {(hasReasoning || isGenerating) && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="-mx-1 inline-flex items-center gap-2 rounded-control px-2 py-0.5 hover:bg-hover-2 text-ink-2 transition-colors cursor-pointer select-none"
            aria-expanded={open}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill={isGenerating ? "var(--ink-2)" : "var(--ink-3)"}
              className={cn("shrink-0", isGenerating && "animate-pulse")}
            >
              <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
            </svg>

            {isGenerating && orbStyle !== "off" && (
              <span className="inline-flex items-center transition-opacity duration-300">
                <ThinkingOrb state={orbStyle || "solving"} size={20} theme={isDark ? "dark" : "light"} />
              </span>
            )}

            <span role="status" className="contents">
              {isGenerating ? (
                <span
                  className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
                  style={{
                    backgroundImage:
                      "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
                    backgroundSize: "200% 100%",
                    animation: "shimmer-text 1.4s linear infinite",
                  }}
                >
                  Thinking...
                </span>
              ) : (
                <span
                  className="text-[13px] font-medium whitespace-nowrap text-ink-2"
                  style={{ animation: "fade-in 350ms ease-out both" }}
                >
                  {open
                    ? `Hide thinking${rawBlocks.length > 1 ? ` (${rawBlocks.length} blocks)` : ""}`
                    : `Show thinking${rawBlocks.length > 1 ? ` (${rawBlocks.length} blocks)` : ""}`}
                </span>
              )}
            </span>

            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ink-3)"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-transform duration-300 shrink-0"
              style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
        {chips.map((chip) => (
          <span key={chip} className="font-mono text-[11px] text-ink-3">
            {chip}
          </span>
        ))}
      </div>

      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
          !isExpanded && "invisible h-0 opacity-0 pointer-events-none overflow-hidden"
        )}
        style={{
          gridTemplateRows: isExpanded ? "1fr" : "0fr",
          opacity: isExpanded ? 1 : 0,
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] top-0 bottom-1 w-px bg-line"
            />
            <div className="rounded-lg border border-line bg-surface/60 p-3 space-y-2.5">
              <p className="text-[11.5px] text-ink-3">
                The model&apos;s working trace. Internal deliberation and diagnostics.
              </p>

              {rawBlocks.length === 1 ? (
                <div
                  ref={preRef}
                  className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-2"
                >
                  <AnimatedStreamingText
                    content={rawBlocks[0]}
                    isStreaming={isGenerating}
                    animation="blurIn"
                    animationDuration="0.32s"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  {rawBlocks.map((block, idx) => {
                    const isLatestBlock = idx === rawBlocks.length - 1;
                    return (
                      <div key={idx} className="rounded-md border border-line/80 bg-field/40 p-2.5">
                        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                          <Sparkles className="h-3 w-3 text-amber-500" />
                          <span>Thinking Block {idx + 1}</span>
                        </div>
                        <div className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-2">
                          <AnimatedStreamingText
                            content={block}
                            isStreaming={isGenerating && isLatestBlock}
                            animation="blurIn"
                            animationDuration="0.32s"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {stats?.traceId && (
                <p className="mt-2 font-mono text-[10px] text-ink-3">
                  trace {stats.traceId}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

