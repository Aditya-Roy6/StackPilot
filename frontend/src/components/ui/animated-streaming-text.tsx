"use client";

import React, { useRef, useMemo } from "react";
import { cn } from "@/lib/utils";

interface AnimatedStreamingTextProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
  animation?: "blurIn" | "fadeIn" | null;
  animationDuration?: string;
}

/**
 * AnimatedStreamingText
 *
 * Silky-smooth streaming token entrance animation (blur-in flow) for real-time text.
 * Tracks previously settled tokens and applies CSS keyframes (`ft-blurIn`) exclusively
 * to newly arriving tokens.
 */
export function AnimatedStreamingText({
  content,
  isStreaming = false,
  className,
  animation = "blurIn",
  animationDuration = "0.32s",
}: AnimatedStreamingTextProps) {
  const prevContentRef = useRef("");
  const tokensRef = useRef<{ id: number; text: string; isNew: boolean }[]>([]);
  const idCounterRef = useRef(0);

  const tokens = useMemo(() => {
    if (!content) return [];

    // If not streaming or animation disabled, return the full content directly
    if (!isStreaming || animation === null) {
      tokensRef.current = [{ id: 0, text: content, isNew: false }];
      prevContentRef.current = content;
      return tokensRef.current;
    }

    const prevText = prevContentRef.current;

    // Reset if content decreased or completely replaced
    if (!prevText || content.length < prevText.length || !content.startsWith(prevText)) {
      idCounterRef.current = 1;
      // Pre-existing content is marked as settled (not new), so it does not re-animate
      tokensRef.current = [{ id: 1, text: content, isNew: false }];
      prevContentRef.current = content;
      return tokensRef.current;
    }

    // Incremental stream update: compute delta
    if (content !== prevText) {
      const delta = content.slice(prevText.length);
      if (delta) {
        // Tokenize by whitespace while preserving whitespace and newlines
        const parts = delta.split(/(\s+)/).filter(Boolean);
        for (const part of parts) {
          idCounterRef.current += 1;
          tokensRef.current.push({
            id: idCounterRef.current,
            text: part,
            isNew: true,
          });
        }
      }
      prevContentRef.current = content;
    }

    // Safety check: ensure we always have content in tokens
    if (tokensRef.current.length === 0 && content) {
      tokensRef.current = [{ id: 0, text: content, isNew: false }];
    }

    return tokensRef.current;
  }, [content, isStreaming, animation]);

  if (!content) return null;

  if (!isStreaming || animation === null || tokens.length === 0) {
    return <span className={className}>{content}</span>;
  }

  return (
    <span className={cn("inline", className)}>
      {tokens.map((token) =>
        token.isNew ? (
          <span
            key={token.id}
            className="animate-flow-blur-in inline-block whitespace-pre-wrap"
            style={{ animationDuration }}
          >
            {token.text}
          </span>
        ) : (
          <span key={token.id} className="inline whitespace-pre-wrap">
            {token.text}
          </span>
        )
      )}
    </span>
  );
}
