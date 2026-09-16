"use client";

import React from "react";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Custom dark code theme matching StackPilot's palette.
 * Replaces flowtoken's default light 'docco' theme to eliminate
 * jarring bright white code boxes in dark mode.
 */
const darkCodeTheme: Record<string, React.CSSProperties> = {
  'pre[class*="language-"]': {
    color: "var(--ink, #e4e4e7)",
    fontSize: "12px",
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
    lineHeight: "1.6",
    padding: "0.875rem 1rem",
    margin: "0.5rem 0",
    overflow: "auto",
    background: "var(--field, #18181b)",
    border: "1px solid var(--line, rgba(255, 255, 255, 0.1))",
    borderRadius: "0.5rem",
  },
  'code[class*="language-"]': {
    color: "var(--ink, #e4e4e7)",
    fontSize: "12px",
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
    lineHeight: "1.6",
    background: "transparent",
  },
  comment: { color: "#71717a", fontStyle: "italic" },
  prolog: { color: "#71717a" },
  doctype: { color: "#71717a" },
  cdata: { color: "#71717a" },
  punctuation: { color: "#a1a1aa" },
  property: { color: "#38bdf8" },
  tag: { color: "#f43f5e" },
  boolean: { color: "#fb923c" },
  number: { color: "#fb923c" },
  constant: { color: "#fb923c" },
  symbol: { color: "#fb923c" },
  deleted: { color: "#f43f5e" },
  selector: { color: "#4ade80" },
  "attr-name": { color: "#38bdf8" },
  string: { color: "#4ade80" },
  char: { color: "#4ade80" },
  builtin: { color: "#38bdf8" },
  inserted: { color: "#4ade80" },
  operator: { color: "#38bdf8" },
  entity: { color: "#fbbf24", cursor: "help" },
  url: { color: "#38bdf8" },
  variable: { color: "#f43f5e" },
  atrule: { color: "#c084fc" },
  "attr-value": { color: "#4ade80" },
  function: { color: "#60a5fa" },
  "class-name": { color: "#fbbf24" },
  keyword: { color: "#c084fc" },
  regex: { color: "#fb923c" },
  important: { color: "#fb923c", fontWeight: "bold" },
  bold: { fontWeight: "bold" },
  italic: { fontStyle: "italic" },
};

/**
 * Standard HTML tags that markdown parsers safely recognize.
 * Any non-standard tag (e.g. <host>, <your-deployment-host>, <path>, <token>)
 * gets escaped to &lt;...&gt; so flowtoken's rehype-raw parser does not create
 * unrecognized React DOM elements.
 */
const ALLOWED_HTML_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote",
  "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details",
  "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "small", "span",
  "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "time", "tr", "u", "ul", "var", "wbr"
]);

/**
 * Sanitizes markdown content by escaping non-standard HTML angle bracket expressions
 * like `<host>`, `<your-deployment-host>`, `<path>`, `<token>`, etc. into HTML entities
 * (`&lt;...&gt;`), while preserving markdown autolinks (`<https://...>`, `<http://...>`)
 * and allowed HTML tags.
 */
export function sanitizeMarkdownContent(content: string): string {
  if (!content) return content;

  return content.replace(
    /<\/?([a-zA-Z0-9_.:-]+)(?:\s+[^>]*)?\/?>/g,
    (match, tagName) => {
      // Preserve autolinks e.g. <https://...> or <http://...> or <mailto:...>
      if (
        match.startsWith("<http://") ||
        match.startsWith("<https://") ||
        match.startsWith("<mailto:")
      ) {
        return match;
      }
      const lowerTag = tagName.toLowerCase();
      if (ALLOWED_HTML_TAGS.has(lowerTag)) {
        return match;
      }
      // Non-standard HTML element or placeholder tag: escape to HTML entities
      return match.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  );
}

interface FlowTokenErrorBoundaryProps {
  children: React.ReactNode;
  fallback: React.ReactNode;
}

interface FlowTokenErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches any DOM element or parsing errors thrown during flowtoken rendering
 * and gracefully falls back to ReactMarkdown.
 */
class FlowTokenErrorBoundary extends React.Component<
  FlowTokenErrorBoundaryProps,
  FlowTokenErrorBoundaryState
> {
  constructor(props: FlowTokenErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): FlowTokenErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.warn("FlowTokenMarkdown failed to render, falling back to ReactMarkdown:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

/**
 * Smooth streaming text animation wrapper using the `flowtoken` package.
 *
 * During active streaming, pass `animation="blurIn"` (or "fadeIn", "slideUp", etc.)
 * to animate only newly-arriving tokens. For settled/historical messages, pass
 * `animation={null}` so content renders instantly without re-animating.
 *
 * Uses `next/dynamic` with `{ ssr: false }` to prevent hydration mismatches
 * since flowtoken relies on browser DOM diffing to track new vs. existing tokens.
 */
const FlowTokenMarkdown = dynamic(
  () => import("flowtoken").then((mod) => mod.AnimatedMarkdown),
  { ssr: false }
);

export interface AnimatedMarkdownProps {
  /** The accumulated markdown/text string to display */
  content: string;
  /** Animation name for newly-arrived tokens. Set to null for settled content. */
  animation?: string | null;
  /** CSS duration for each token's entrance animation */
  animationDuration?: string;
  /** CSS timing function for the animation */
  animationTimingFunction?: string;
  /** Token chunking granularity: "diff" (recommended for streaming LLM tokens), "word", or "char" */
  sep?: "diff" | "word" | "char";
  /** Optional custom code style object for syntax highlighting */
  codeStyle?: any;
  /** Optional className for the outer wrapper */
  className?: string;
}

/**
 * AnimatedMarkdown: Drop-in replacement for ReactMarkdown that adds smooth
 * streaming token animation via the `flowtoken` package with dark theme support
 * and fallback error boundary.
 */
export function AnimatedMarkdown({
  content,
  animation = "blurIn",
  animationDuration = "0.35s",
  animationTimingFunction = "ease-out",
  sep = "diff",
  codeStyle = darkCodeTheme,
  className,
}: AnimatedMarkdownProps) {
  if (!content) return null;

  const sanitizedContent = sanitizeMarkdownContent(content);

  return (
    <div className={className}>
      <FlowTokenErrorBoundary
        fallback={
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {sanitizedContent}
          </ReactMarkdown>
        }
      >
        <FlowTokenMarkdown
          content={sanitizedContent}
          animation={animation}
          animationDuration={animationDuration}
          animationTimingFunction={animationTimingFunction}
          sep={sep}
          codeStyle={codeStyle}
        />
      </FlowTokenErrorBoundary>
    </div>
  );
}
