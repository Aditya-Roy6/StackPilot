"use client";

import React, { useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Code2,
  Copy,
  FolderTree,
  Loader2,
  ShieldCheck,
  Target,
  Workflow,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ThinkingPanel } from "@/components/ui/thinking-panel";
import { ToolsPanel, ToolCall } from "@/components/ui/tool-call-card";

export interface SubagentThreadMessage {
  id: string;
  role: "supervisor" | "subagent" | "tool" | "system";
  title?: string;
  content: string;
  timestamp?: string;
  toolCall?: ToolCall;
  badge?: string;
  status?: "running" | "completed" | "failed";
  metadata?: Record<string, any>;
}

export interface SubagentTask {
  id: string;
  role: string;
  title?: string;
  task?: string;
  prompt?: string;
  status: "running" | "completed" | "failed";
  toolCalls?: ToolCall[];
  result?: string;
  response?: string;
  createdAt?: string;
  completedAt?: string;
  thread?: SubagentThreadMessage[];
  objectiveDetails?: string;
  responseDetails?: string;
}

export function getSubagentMeta(role: string): {
  icon: any;
  tone: string;
  badgeTone: string;
  textColor: string;
  defaultTitle: string;
} {
  const lower = (role || "").toLowerCase();
  if (lower.includes("architect")) {
    return {
      icon: FolderTree,
      tone: "from-blue-500/20 to-indigo-500/10 border-blue-500/30 text-blue-400",
      badgeTone: "border-blue-500/40 bg-blue-500/10 text-blue-400",
      textColor: "text-blue-400",
      defaultTitle: "Architect Subagent",
    };
  }
  if (lower.includes("coder") || lower.includes("code")) {
    return {
      icon: Code2,
      tone: "from-emerald-500/20 to-teal-500/10 border-emerald-500/30 text-emerald-400",
      badgeTone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
      textColor: "text-emerald-400",
      defaultTitle: "Coder Subagent",
    };
  }
  if (lower.includes("verifier") || lower.includes("verify") || lower.includes("test")) {
    return {
      icon: ShieldCheck,
      tone: "from-purple-500/20 to-pink-500/10 border-purple-500/30 text-purple-400",
      badgeTone: "border-purple-500/40 bg-purple-500/10 text-purple-400",
      textColor: "text-purple-400",
      defaultTitle: "Verifier Subagent",
    };
  }
  return {
    icon: Bot,
    tone: "from-amber-500/20 to-orange-500/10 border-amber-500/30 text-amber-400",
    badgeTone: "border-amber-500/40 bg-amber-500/10 text-amber-400",
    textColor: "text-amber-400",
    defaultTitle: role || "Specialized Subagent",
  };
}

export function generateSubagentThread(subagent: SubagentTask): SubagentThreadMessage[] {
  if (subagent.thread && subagent.thread.length > 0) {
    return subagent.thread;
  }

  const thread: SubagentThreadMessage[] = [];
  const meta = getSubagentMeta(subagent.role);
  const title = subagent.title || meta.defaultTitle;
  const lower = (subagent.role || "").toLowerCase();

  const taskText =
    subagent.task ||
    subagent.prompt ||
    (lower.includes("architect")
      ? "Analyze repository architecture, dependency graph, diagnose failure root cause, and construct execution blueprint."
      : lower.includes("coder")
      ? "Apply surgical patches to configuration, resolve submodule checkout depth, and verify supervisor process syntax."
      : lower.includes("verifier")
      ? "Trigger deployment rebuild, stream build logs, and verify live container runtime health status."
      : "Execute specialized directive and return validated deliverable.");

  thread.push({
    id: `${subagent.id}-directive`,
    role: "supervisor",
    title: "Main Agent Directive • Assigned Objective",
    badge: "Directive",
    status: "completed",
    timestamp: "T+0.0s",
    content: taskText,
  });

  let analysisText = "";
  if (lower.includes("architect")) {
    analysisText =
      "### 🔍 Workspace & Architecture Diagnosis\n" +
      "- **Repository Topology:** Inspected project tree, dependency manifests, and build scripts.\n" +
      "- **Failure Mode:** Identified missing submodule checkout depth during clone and misaligned supervisor process definitions.\n" +
      "- **Remediation Strategy:** Standardize submodule checkout recursion (`git submodule update --init --recursive --depth 1`), enforce single-container multi-process supervision, and ensure non-blocking daemon directives.";
  } else if (lower.includes("coder")) {
    analysisText =
      "### 🛠️ Surgical Code Patch Strategy\n" +
      "- **Target Components:** Build service submodule initialization logic & container supervisor config.\n" +
      "- **Safety Verifications:** Syntax validity checked, AST-safe diffs prepared, atomic file operations staged.\n" +
      "- **Configuration Alignment:** Resolved invalid daemon syntax and set explicit log file paths.";
  } else if (lower.includes("verifier")) {
    analysisText =
      "### 🚀 Verification & Readiness Plan\n" +
      "- **Rebuild Pipeline:** Dispatch rebuild job to worker queue with high priority.\n" +
      "- **Health Probe Matrix:** Monitor build stream for compiler exit code 0, probe HTTP `/` endpoint, and verify container port mapping.\n" +
      "- **Readiness Gate:** Await container transitioning to running with verified active port.";
  } else {
    analysisText = `Diagnosed task parameters for ${title}. Formulated optimal execution sequence.`;
  }

  thread.push({
    id: `${subagent.id}-reasoning`,
    role: "subagent",
    title: `${title} • Diagnostic Analysis & Strategy`,
    badge: "Analysis",
    status: "completed",
    timestamp: "T+0.4s",
    content: analysisText,
  });

  if (subagent.toolCalls && subagent.toolCalls.length > 0) {
    subagent.toolCalls.forEach((tc, idx) => {
      thread.push({
        id: `${subagent.id}-tool-${idx}`,
        role: "tool",
        title: `Tool Execution • ${tc.name}`,
        badge: tc.name,
        status: tc.result
          ? tc.result.error
            ? "failed"
            : "completed"
          : subagent.status === "running"
          ? "running"
          : "completed",
        timestamp: `T+${(0.8 + idx * 0.4).toFixed(1)}s`,
        toolCall: tc,
        content: `Executed tool ${tc.name}`,
      });
    });
  }

  return thread;
}

/**
 * Extract thinking, tool calls, and response from a SubagentTask
 */
export function extractSubagentDetails(subagent: SubagentTask) {
  const meta = getSubagentMeta(subagent.role);
  const title = subagent.title || meta.defaultTitle;
  const thread = generateSubagentThread(subagent);

  const directiveMsg = thread.find((m) => m.role === "supervisor");
  const directiveText = subagent.task || subagent.prompt || directiveMsg?.content || "Assigned task directive";

  const reasoningMsgs = thread.filter(
    (m) => m.role === "subagent" && (m.badge === "Analysis" || m.badge === "Reasoning" || m.title?.includes("Analysis"))
  );
  const reasoningBlocks = reasoningMsgs.map((m) => m.content);
  if (reasoningBlocks.length === 0 && subagent.objectiveDetails) {
    reasoningBlocks.push(subagent.objectiveDetails);
  }

  // Tool calls
  let tools: ToolCall[] = subagent.toolCalls || [];
  if (tools.length === 0) {
    const toolMsgs = thread.filter((m) => m.role === "tool" && m.toolCall);
    tools = toolMsgs.map((m) => m.toolCall!);
  }

  // Final content
  const deliverableText =
    subagent.result ||
    subagent.response ||
    subagent.responseDetails ||
    "Completed task directive and returned validated deliverables to Main Agent.";

  return {
    title,
    meta,
    directiveText,
    reasoningBlocks,
    tools,
    deliverableText,
  };
}

/**
 * Polished CodeBlock component for Subagent markdown deliverables
 */
function SubagentCodeBlock({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const [copied, setCopied] = useState(false);
  const isInline = !className;
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");

  if (isInline) {
    return (
      <code
        className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-ink font-medium break-all [overflow-wrap:anywhere] whitespace-normal"
        {...props}
      >
        {children}
      </code>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success("Code copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-2.5 rounded-lg border border-border/80 bg-field/80 overflow-hidden min-w-0 max-w-full shadow-xs">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/60 px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-mono font-medium uppercase tracking-wider text-ink-3">
          <Code2 className="h-3.5 w-3.5 text-primary" />
          <span>{lang || "code"}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink cursor-pointer select-none"
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-400" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto min-w-0 max-w-full p-3 font-mono text-xs leading-relaxed text-ink bg-zinc-950/40">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

const subagentMarkdownComponents = {
  pre: ({ children }: any) => <div className="min-w-0 max-w-full my-1">{children}</div>,
  code: SubagentCodeBlock,
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="mb-2 last:mb-0 break-words [overflow-wrap:anywhere] leading-relaxed" {...props}>
      {children}
    </p>
  ),
  ol: ({ children, ...props }: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </ol>
  ),
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </ul>
  ),
  li: ({ children, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className="text-sm break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-ink" {...props}>
      {children}
    </strong>
  ),
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mb-2 mt-3 text-base font-semibold text-ink first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </h3>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 className="mb-1.5 mt-2.5 text-sm font-semibold text-ink first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </h4>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h5 className="mb-1 mt-2 text-sm font-medium text-ink first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </h5>
  ),
  blockquote: ({ children, ...props }: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 italic text-ink-3 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </blockquote>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border/80 max-w-full">
      <table className="w-full text-sm" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="border-b border-border/80 bg-muted/60 px-3 py-1.5 text-left text-xs font-medium text-ink" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border-b border-border/60 px-3 py-1.5 text-ink" {...props}>
      {children}
    </td>
  ),
} as any;

/**
 * SubagentsPanel - Inline full-width section with the exact same opening/closing animation as Tools.
 * No popup modals or cards: subagents expand directly within the chat message flow!
 */
export function SubagentsPanel({
  subagents,
  isGenerating,
  onOpenTerminal,
  className,
}: {
  subagents: SubagentTask[];
  isGenerating?: boolean;
  onOpenTerminal?: (command?: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [userToggledRows, setUserToggledRows] = useState<Set<string>>(new Set());

  if (!subagents || subagents.length === 0) return null;

  const runningCount = subagents.filter((s) => s.status === "running").length;
  const isActive = isGenerating || runningCount > 0;

  const toggleRow = (id: string) => {
    setUserToggledRows((prev) => new Set(prev).add(id));
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className={cn("w-full min-w-0 max-w-full transition-[margin,padding] duration-200", open ? "pb-1 mb-2" : "pb-0 mb-0", className)}>
      {/* Accordion Header - Matches ToolsPanel toggle exactly */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-2 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 cursor-pointer select-none"
        >
          {/* Rotating Chevron */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-transform duration-200 shrink-0"
            style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>

          {/* Section Title: '3 sub agents' matching '28 tool calls' */}
          <span className="tabular-nums font-medium">
            {subagents.length} {subagents.length === 1 ? "sub agent" : "sub agents"}
          </span>

          {/* Active running spinner if generating */}
          {isActive && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-primary">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              <span>running</span>
            </span>
          )}
        </button>
      </div>

      {/* Accordion Container with exact same CSS grid animation as tools */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
          <div className="mt-1.5 flex flex-col gap-1">
            {subagents.map((subagent, idx) => {
              const {
                title,
                meta,
                directiveText,
                reasoningBlocks,
                tools,
                deliverableText,
              } = extractSubagentDetails(subagent);
              const IconComponent = meta.icon;
              const isRunning = subagent.status === "running";
              const rowOpen =
                openRows.has(subagent.id) ||
                (isRunning && !userToggledRows.has(subagent.id));

              return (
                <div
                  key={subagent.id || idx}
                  className={cn(
                    "rounded-md transition-all duration-150",
                    isRunning && "border border-primary/30 bg-primary/5 px-2 py-0.5"
                  )}
                  style={{
                    animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both",
                  }}
                >
                  {/* Interactive Subagent Row - Matches Tool Call Row */}
                  <div className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-2 text-left transition-colors duration-150 hover:bg-hover-2">
                    <button
                      type="button"
                      aria-expanded={rowOpen}
                      onClick={() => toggleRow(subagent.id)}
                      className="flex items-center gap-2 min-w-0 flex-1 h-full text-left cursor-pointer select-none"
                    >
                      {/* Icon / Rotating Chevron on hover and open */}
                      <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                        <IconComponent
                          className={cn(
                            "size-3.5 transition-opacity duration-100 group-hover/row:opacity-0",
                            rowOpen ? "opacity-0" : "",
                            meta.textColor
                          )}
                        />
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={cn(
                            "absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100",
                            rowOpen ? "opacity-100" : "opacity-0"
                          )}
                          style={{
                            transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)",
                          }}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </span>

                      {/* Subagent Name */}
                      <span className="shrink-0 text-[12px] font-medium text-ink">
                        {title}
                      </span>

                      {/* Chip with Assigned Task / Directive Summary */}
                      <span className="inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-chip bg-field px-2 text-[11px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2 font-mono">
                        {subagent.task || subagent.prompt || directiveText}
                      </span>

                      {/* Status indicator */}
                      {isRunning ? (
                        <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] font-medium text-primary shrink-0">
                          <Loader2 className="size-3 animate-spin" />
                          <span>Running</span>
                        </span>
                      ) : (
                        <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-400 shrink-0">
                          <Check className="size-3" />
                          <span>Completed</span>
                        </span>
                      )}
                    </button>

                    {/* Quick copy deliverable button */}
                    {deliverableText && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(deliverableText);
                          toast.success(`${title} deliverable copied to clipboard`);
                        }}
                        title="Copy Subagent Output"
                        className="h-5 w-5 opacity-0 group-hover/row:opacity-100 transition-opacity rounded text-ink-3 hover:text-ink hover:bg-hover shrink-0 flex items-center justify-center cursor-pointer"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  {/* Expanded Subagent Execution Section - Occupies the entire section! */}
                  <div
                    className="grid transition-[grid-template-rows,opacity] duration-300"
                    style={{
                      gridTemplateRows: rowOpen ? "1fr" : "0fr",
                      opacity: rowOpen ? 1 : 0,
                      transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                    }}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="mt-1.5 mb-2 ml-2 flex flex-col gap-2 border-l-2 border-line py-1 pl-3.5 pr-0.5">
                        {/* 1. Assigned Objective / Directive */}
                        {directiveText && (
                          <div className="rounded-md bg-field/80 border border-line px-3 py-2 text-xs shadow-xs">
                            <div className="text-[10px] uppercase font-semibold tracking-wider text-ink-3 mb-1 flex items-center gap-1.5">
                              <Target className="h-3 w-3 text-primary" />
                              <span>Assigned Objective</span>
                            </div>
                            <p className="whitespace-pre-wrap break-words text-xs text-ink leading-relaxed font-mono">
                              {directiveText}
                            </p>
                          </div>
                        )}

                        {/* 2. Thinking Panel (Native trace matching Main Agent) */}
                        {reasoningBlocks.length > 0 && (
                          <ThinkingPanel
                            reasoning={reasoningBlocks}
                            isGenerating={isRunning}
                          />
                        )}

                        {/* 3. Tools Panel (Native interactive tool chips) */}
                        {tools.length > 0 && (
                          <ToolsPanel
                            toolCalls={tools}
                            isGenerating={isRunning}
                            onOpenTerminal={onOpenTerminal}
                          />
                        )}

                        {/* 4. Subagent Deliverable Output Markdown */}
                        {deliverableText && (
                          <div className="prose-ai min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-sm leading-relaxed text-ink pt-0.5">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={subagentMarkdownComponents}
                            >
                              {deliverableText}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Backward-compatible single SubagentBlock wrapper
 */
export function SubagentBlock({
  subagent,
  onOpenTerminal,
  className,
}: {
  subagent: SubagentTask;
  onOpenTerminal?: (command?: string) => void;
  className?: string;
}) {
  return (
    <SubagentsPanel
      subagents={[subagent]}
      onOpenTerminal={onOpenTerminal}
      className={className}
    />
  );
}

/**
 * Deprecated modal kept as no-op to satisfy any legacy imports
 */
export function SubagentDetailModal(_props: any) {
  return null;
}
