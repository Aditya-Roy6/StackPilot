"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import {
  Brain,
  BrainCircuit,
  Check,
  ChevronDown,
  ClipboardCopy,
  Clock,
  Copy,
  GitFork,
  Loader2,
  Mic,
  MicOff,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Square,
  Star,
  Terminal,
  Trash2,
  Maximize2,
  Minimize2,
  CornerDownLeft,
  X,
  Zap,
} from "lucide-react";
import { AppIcon } from "@/lib/custom-icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { useTheme } from "next-themes";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { toast } from "sonner";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { StatusVerb } from "@/components/ui/status-verb";
import { ThinkingPanel } from "@/components/ui/thinking-panel";
import { ToolCallCard, ToolCall, ToolsPanel } from "@/components/ui/tool-call-card";
import { streamAgentReply } from "@/lib/stream-agent";

// Must exceed the ai-service (90s) and backend (120s) timeouts, otherwise the
// browser aborts while the backend completes the generation and bills for it.
const AI_REQUEST_TIMEOUT_MS = 130000;

type AiMode = "fast" | "thinking";
type AiProvider = "nvidia_nim" | "openai_compatible";
type Role = "user" | "assistant" | "system";

export type ThinkingOrbStyle = OrbState | "off";

export interface OrbStyleDefinition {
  id: ThinkingOrbStyle;
  label: string;
  description: string;
}

export const ORB_STYLES: OrbStyleDefinition[] = [
  { id: "solving", label: "Solving", description: "Quarter-turn bands scramble and click back into place" },
  { id: "searching", label: "Searching", description: "A scan meridian sweeps across a dotted globe" },
  { id: "working", label: "Working", description: "Particle dots on tilted multi-axis orbits" },
  { id: "weaving", label: "Weaving", description: "Three helix strands plait smoothly around the sphere" },
  { id: "composing", label: "Composing", description: "An undulating multi-band sash in rhythmic motion" },
  { id: "breathing", label: "Breathing", description: "A gentle face-on ring expanding and contracting" },
  { id: "shaping", label: "Shaping", description: "A dotted outline morphing circle → triangle → square" },
  { id: "connecting", label: "Connecting", description: "A dynamic constellation wiring itself with network packets" },
  { id: "listening", label: "Listening", description: "A rhythmic waveform rolling through latitude rings" },
  { id: "off", label: "Turn Off", description: "Disable the thinking orb animation completely" },
];

interface AiModel {
  id: string;
  label?: string;
  mode?: AiMode;
}

interface AiModelsResponse {
  provider: AiProvider;
  selected_model: string;
  source: "provider" | "provider_verified" | "fallback" | "fallback_probe_failed";
  models: AiModel[];
}

interface AiSettingsResponse {
  enabled: boolean;
  provider: AiProvider;
  model?: string;
  openai_compatible_base_url?: string;
  has_nvidia_key?: boolean;
  has_openai_compatible_key?: boolean;
  confidence_threshold?: number;
  history_retention_days?: number;
}

interface AiResponse {
  status: "ok" | "error";
  confidence?: number;
  summary?: string;
  structured_output?: Record<string, unknown>;
  warnings?: string[];
  error?: string;
  model?: string;
  provider?: string;
  run_id?: string;
  session_id?: string;
  session_title?: string;
  /** Present only for models that emit reasoning_content. */
  reasoning?: string;
  latency_ms?: number;
  token_usage?: Record<string, number>;
  trace_id?: string;
}

interface Project {
  id: string;
  name: string;
  status?: string;
  source_type?: string;
  repo_url?: string;
}

interface Deployment {
  id: string;
  project_id: string;
  project_name: string;
  status: string;
  version: string;
  image_name?: string;
  runtime_url?: string;
  created_at: string;
}

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  meta?: string;
  /** The model's working, when it exposes reasoning_content. */
  reasoning?: string;
  toolCalls?: ToolCall[];
  stats?: {
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    confidence?: number;
    model?: string;
    provider?: string;
    traceId?: string;
  };
}

interface AiChatSession {
  id: string;
  title: string;
  session_type: string;
  project_id?: string;
  preview?: string;
  message_count?: number;
  last_model?: string;
  memory_summary?: string;
  created_at: string;
  updated_at: string;
}

interface AiChatMessage {
  id: string;
  role: Role | "tool";
  content: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

interface TerminalExecutionLog {
  id: string;
  command: string;
  timestamp: string;
  status: "running" | "success" | "error";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  cwd?: string;
}

interface AgentApplicationTemplate {
  id: string;
  name: string;
  aliases: string[];
  defaultPort: string;
  config: (password: string, rootPassword: string) => Record<string, string>;
  summary: (config: Record<string, string>) => string[];
}

const commands = [
  {
    name: "/architect",
    arg: "none" as const,
    icon: Sparkles,
    usage: "/architect <requirements or architectural goal>",
    description: "Launch Strategic AI Architect subagent swarm to formulate blueprints, inspect dependencies, and plan execution.",
  },
  {
    name: "/swarm",
    arg: "none" as const,
    icon: Sparkles,
    usage: "/swarm <complex goal>",
    description: "Multi-agent collaborative execution: Architect, Coder, and Verifier working in concert.",
  },
  {
    name: "/plan",
    arg: "none" as const,
    icon: Sparkles,
    usage: "/plan <feature or refactor>",
    description: "Produce a structured engineering plan and architectural blueprint with step-by-step phases.",
  },
  {
    name: "/audit",
    arg: "none" as const,
    icon: Sparkles,
    usage: "/audit [target]",
    description: "Comprehensive workspace audit: security posture, container health, and performance analysis.",
  },
  {
    name: "/cost",
    arg: "none" as const,
    icon: Star,
    usage: "/cost [days]",
    description: "What deployments have cost, by project, with preview spend broken out.",
  },
  {
    name: "/drift",
    arg: "deployment" as const,
    icon: Star,
    usage: "/drift <deployment-id>",
    description: "Compare recorded desired state against what the cluster actually has.",
  },
  {
    name: "/secrets",
    arg: "project" as const,
    icon: Star,
    usage: "/secrets [project-id]",
    description: "List stored secret keys. Values are never shown here.",
  },
  {
    name: "/scale",
    arg: "deployment" as const,
    icon: Star,
    usage: "/scale <deployment-id> <replicas>",
    description: "Change replica count on a running Kubernetes deployment.",
  },
  {
    name: "/rollback",
    arg: "deployment" as const,
    icon: Star,
    usage: "/rollback <deployment-id>",
    description: "Roll a Kubernetes deployment back to its previous revision.",
  },
  {
    name: "/pause",
    arg: "deployment" as const,
    icon: Star,
    usage: "/pause <deployment-id>",
    description: "Pause a running runtime so it stops serving traffic.",
  },
  {
    name: "/resume",
    arg: "deployment" as const,
    icon: Star,
    usage: "/resume <deployment-id>",
    description: "Resume a paused runtime.",
  },
  {
    name: "/events",
    arg: "deployment" as const,
    icon: Star,
    usage: "/events <deployment-id>",
    description: "Kubernetes events — often explains a crash loop better than logs.",
  },
  {
    name: "/metrics",
    arg: "deployment" as const,
    icon: Star,
    usage: "/metrics <deployment-id>",
    description: "CPU, memory and runtime metrics for a deployment.",
  },
  {
    name: "/org",
    arg: "none" as const,
    icon: Star,
    usage: "/org",
    description: "Organizations you belong to and your role in each.",
  },
  {
    name: "/environments",
    arg: "project" as const,
    icon: Star,
    usage: "/environments <project-id>",
    description: "A project's environments, branches and auto-deploy settings.",
  },
  {
    name: "/terminal",
    arg: "command" as const,
    icon: Terminal,
    usage: "/terminal <command>",
    description: "Execute a command in the active deployment/project workspace terminal.",
  },
  {
    name: "/run",
    arg: "command" as const,
    icon: Terminal,
    usage: "/run <command>",
    description: "Run a shell or PowerShell command in the workspace.",
  },
  {
    name: "/diagnose",
    arg: "deployment" as const,
    icon: Star,
    usage: "/diagnose <deployment-id>",
    description: "Analyze failed builds or runtime health using logs and deployment context.",
  },
  {
    name: "/repair",
    arg: "deployment" as const,
    icon: Star,
    usage: "/repair <deployment-id>",
    description: "Autonomous AI project repair: diagnose, auto-patch files, and re-deploy.",
  },
  {
    name: "/build",
    arg: "deployment" as const,
    icon: Star,
    usage: "/build <deployment-id>",
    description: "Queue a real deployment build in the platform worker.",
  },
  {
    name: "/deploy",
    arg: "deployment" as const,
    icon: Star,
    usage: "/deploy <deployment-id> [port]",
    description: "Deploy an already built image to Kubernetes with safe defaults.",
  },
  {
    name: "/dockerfile",
    arg: "project" as const,
    icon: Star,
    usage: "/dockerfile <project-id>",
    description: "Generate a Dockerfile plan for scripts, apps, and unknown project types.",
  },
  {
    name: "/analyze",
    arg: "project" as const,
    icon: Star,
    usage: "/analyze <project-id>",
    description: "Classify a project and infer runtime, entrypoint, framework, and port.",
  },
  {
    name: "/app",
    arg: "app" as const,
    icon: Star,
    usage: "/app mysql",
    description: "Create and deploy an Application-source service such as MySQL, PostgreSQL, Redis, Grafana, or MinIO.",
  },
] as const;

const agentApplicationTemplates: AgentApplicationTemplate[] = [
  {
    id: "mysql",
    name: "MySQL database",
    aliases: ["mysql", "my sql"],
    defaultPort: "13306",
    config: (password, rootPassword) => ({
      public_port: "13306",
      database: "app",
      username: "app",
      password,
      root_password: rootPassword,
    }),
    summary: (config) => [
      `Database: ${config.database}`,
      `Username: ${config.username}`,
      `Password: ${config.password}`,
      `Root password: ${config.root_password}`,
      `Host port: ${config.public_port}`,
    ],
  },
  {
    id: "postgres",
    name: "PostgreSQL database",
    aliases: ["postgres", "postgresql", "postgre"],
    defaultPort: "15432",
    config: (password) => ({
      public_port: "15432",
      database: "app",
      username: "app",
      password,
    }),
    summary: (config) => [
      `Database: ${config.database}`,
      `Username: ${config.username}`,
      `Password: ${config.password}`,
      `Host port: ${config.public_port}`,
    ],
  },
  {
    id: "redis",
    name: "Redis cache",
    aliases: ["redis", "cache"],
    defaultPort: "16379",
    config: (password) => ({
      public_port: "16379",
      password,
    }),
    summary: (config) => [`Password: ${config.password}`, `Host port: ${config.public_port}`],
  },
  {
    id: "mongo",
    name: "MongoDB database",
    aliases: ["mongo", "mongodb"],
    defaultPort: "27018",
    config: (password) => ({
      public_port: "27018",
      username: "admin",
      password,
    }),
    summary: (config) => [`Username: ${config.username}`, `Password: ${config.password}`, `Host port: ${config.public_port}`],
  },
  {
    id: "mariadb",
    name: "MariaDB database",
    aliases: ["mariadb", "maria db"],
    defaultPort: "13307",
    config: (password, rootPassword) => ({
      public_port: "13307",
      database: "app",
      username: "app",
      password,
      root_password: rootPassword,
    }),
    summary: (config) => [
      `Database: ${config.database}`,
      `Username: ${config.username}`,
      `Password: ${config.password}`,
      `Root password: ${config.root_password}`,
      `Host port: ${config.public_port}`,
    ],
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ broker",
    aliases: ["rabbitmq", "rabbit mq", "queue"],
    defaultPort: "15672",
    config: (password) => ({
      public_port: "15672",
      public_ui_port: "15673",
      username: "admin",
      password,
    }),
    summary: (config) => [
      `Username: ${config.username}`,
      `Password: ${config.password}`,
      `Broker port: ${config.public_port}`,
      `Management UI port: ${config.public_ui_port}`,
    ],
  },
  {
    id: "minio",
    name: "MinIO object storage",
    aliases: ["minio", "s3", "object storage"],
    defaultPort: "19000",
    config: (password) => ({
      public_port: "19000",
      public_ui_port: "19001",
      username: "minioadmin",
      password,
    }),
    summary: (config) => [
      `Root user: ${config.username}`,
      `Root password: ${config.password}`,
      `S3 API port: ${config.public_port}`,
      `Console port: ${config.public_ui_port}`,
    ],
  },
  {
    id: "grafana",
    name: "Grafana",
    aliases: ["grafana", "dashboard", "monitoring dashboard"],
    defaultPort: "13000",
    config: (password) => ({
      public_port: "13000",
      username: "admin",
      password,
    }),
    summary: (config) => [`Admin user: ${config.username}`, `Admin password: ${config.password}`, `Host port: ${config.public_port}`],
  },
  {
    id: "prometheus",
    name: "Prometheus",
    aliases: ["prometheus", "metrics"],
    defaultPort: "19090",
    config: () => ({
      public_port: "19090",
    }),
    summary: (config) => [`Host port: ${config.public_port}`],
  },
  {
    id: "adminer",
    name: "Adminer",
    aliases: ["adminer", "database admin"],
    defaultPort: "18080",
    config: () => ({
      public_port: "18080",
    }),
    summary: (config) => [`Host port: ${config.public_port}`],
  },
];

const starterMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "I can reason about deployments and run real platform actions. Try “deploy a MySQL database”, /app redis, /diagnose with a failed deployment, /build to queue a build, or ask a normal question.",
  },
];

const defaultModels: AiModel[] = [];

function FilledStarIcon({ className }: { className?: string }) {
  return <AppIcon name="star" fallback={Star} className={className} fill="currentColor" strokeWidth={2.4}  />;
}

function shortId(id?: string, size = 8) {
  if (!id) return "-";
  if (id.length <= size + 4) return id;
  return `${id.slice(0, size)}...${id.slice(-4)}`;
}

function preferredApplicationEndpointPort(config: Record<string, string>, fallbackPort: string | number) {
  return config.public_ui_port || config.public_port || String(fallbackPort);
}

function redactSecretLine(line: string) {
  return /(password|secret|token|api key|apikey|private key)/i.test(line)
    ? line.replace(/:\s*.+$/, ": saved in project environment")
    : line;
}

function safeApplicationSummary(template: AgentApplicationTemplate, config: Record<string, string>) {
  return template.summary(config).map(redactSecretLine);
}

function sanitizeHistoryContent(content: string) {
  return content
    .split("\n")
    .map(redactSecretLine)
    .join("\n");
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof AxiosError) {
    if (error.code === "ECONNABORTED") {
      return "The AI provider took too long to respond. Try Fast mode or a smaller chat model.";
    }
    const data = error.response?.data as { error?: string; summary?: string; detail?: string } | undefined;
    return data?.error || data?.summary || data?.detail || fallback;
  }
  return fallback;
}

function formatAiOutput(result: AiResponse) {
  const lines: string[] = [];
  const output = result.structured_output || {};

  // Architecture section
  const arch = output.architecture as Record<string, unknown> | undefined;
  if (arch && typeof arch === "object") {
    lines.push("### 🏗 Architecture & Stack Overview");
    if (arch.framework || arch.primary_language) {
      lines.push(`- **Framework / Language:** ${arch.framework || "N/A"} (${arch.primary_language || "N/A"})`);
    }
    if (arch.project_type) lines.push(`- **Project Type:** ${arch.project_type}`);
    if (arch.build_system) lines.push(`- **Build System:** ${arch.build_system}`);
    if (arch.entry_point) lines.push(`- **Entry Point:** \`${arch.entry_point}\``);
    if (Array.isArray(arch.key_dependencies) && arch.key_dependencies.length > 0) {
      lines.push(`- **Key Dependencies:** ${arch.key_dependencies.slice(0, 8).map((d) => `\`${d}\``).join(", ")}`);
    }
    lines.push("");
  }

  // Deployment readiness assessment
  const readiness = output.readiness_assessment as Record<string, unknown> | undefined;
  if (readiness && typeof readiness === "object") {
    const score = readiness.readiness_score !== undefined ? `${readiness.readiness_score}/100` : "";
    const status = String(readiness.status || "").toUpperCase();
    lines.push(`### 🎯 Deployment Readiness: **${status}** ${score ? `(${score})` : ""}`);
    if (readiness.verdict) {
      lines.push(`> ${readiness.verdict}\n`);
    }
  }

  // Findings
  const findings = output.findings as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(findings) && findings.length > 0) {
    lines.push("### 🔍 Technical Findings");
    findings.forEach((f) => {
      const sev = String(f.severity || "info").toUpperCase();
      const badge = sev === "BLOCKER" || sev === "CRITICAL" ? "🔴" : sev === "WARNING" ? "🟡" : "🔵";
      const file = f.file_path ? ` (\`${f.file_path}\`)` : "";
      lines.push(`- ${badge} **[${sev}]** ${f.title || f.category || "Issue"}${file}: ${f.description || ""}`);
    });
    lines.push("");
  }

  // Primary summary or error
  if (result.summary) {
    lines.push(result.summary);
  } else if (result.error) {
    lines.push(`⚠️ ${result.error}`);
  }

  const rootCause = output.root_cause || output.likely_root_cause || output.diagnosis;
  if (typeof rootCause === "string" && rootCause.trim() && !lines.join(" ").includes(rootCause.trim())) {
    lines.push(`\n**Root cause:** ${rootCause}`);
  }

  // Recommendations or steps
  const recs = output.recommendations as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(recs) && recs.length > 0) {
    lines.push("\n### 💡 Recommended Actions");
    recs.forEach((rec, idx) => {
      if (typeof rec === "string") {
        lines.push(`${idx + 1}. ${rec}`);
      } else {
        const priority = rec.priority ? `*[${rec.priority}]* ` : "";
        const title = rec.title ? `**${rec.title}**: ` : "";
        const action = rec.action || "";
        const rationale = rec.rationale ? ` _(${rec.rationale})_` : "";
        lines.push(`${idx + 1}. ${priority}${title}${action}${rationale}`);
      }
    });
  } else {
    const steps = output.fix_steps || output.steps || output.safe_remediations;
    if (Array.isArray(steps) && steps.length > 0) {
      lines.push("\n**Next steps:**");
      steps.slice(0, 6).forEach((step, index) => {
        lines.push(`${index + 1}. ${typeof step === "string" ? step : JSON.stringify(step)}`);
      });
    }
  }

  const dockerfile = output.dockerfile;
  if (typeof dockerfile === "string" && dockerfile.trim()) {
    lines.push(`\n**Generated Dockerfile:**\n\`\`\`dockerfile\n${dockerfile.trim()}\n\`\`\``);
  }
  if (result.warnings?.length) {
    lines.push("\n**Warnings:**");
    result.warnings.slice(0, 4).forEach((warning) => {
      lines.push(`- ${warning}`);
    });
  }
  return lines.length > 0 ? lines.join("\n") : "No output returned.";
}

function parseAssistantMessageContent(rawContent: string, rawReasoning?: string) {
  let content = rawContent || "";
  const reasoningBlocks: string[] = [];

  if (rawReasoning && rawReasoning.trim()) {
    const splitExisting = rawReasoning.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean);
    reasoningBlocks.push(...splitExisting);
  }

  // 1. Extract any <think>...</think> tags from content
  if (content.includes("<think>")) {
    const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    let match;
    while ((match = thinkRegex.exec(content)) !== null) {
      if (match[1] && match[1].trim()) {
        reasoningBlocks.push(match[1].trim());
      }
    }
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (content.startsWith("<think>")) {
      content = content.replace(/^<think>/i, "").trim();
    }
  }

  // 2. Safeguard against raw internal scratchpad thinking leaking into content
  const isScratchpad =
    !content.includes("#") &&
    (content.startsWith("We are given that the deployment failed") ||
     content.startsWith("Let me check") ||
     content.startsWith("Let me inspect") ||
     content.startsWith("Let me look"));

  if (isScratchpad && content.length > 300) {
    reasoningBlocks.push(content);
    content = "Completed workspace actions and diagnostic inspection. See the thinking and tool activity above for details.";
  }

  return {
    content,
    reasoningBlocks,
  };
}

function CodeBlock({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
  const [copied, setCopied] = useState(false);
  const isInline = !className;
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");

  if (isInline) {
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground break-all [overflow-wrap:anywhere] whitespace-normal" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="group relative my-2 rounded-lg border border-border bg-muted/50 overflow-hidden min-w-0 max-w-full">
      <div className="flex items-center justify-between border-b border-border bg-muted/80 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {copied ? <AppIcon name="check" fallback={Check} className="h-3 w-3"  /> : <AppIcon name="clipboard-copy" fallback={ClipboardCopy} className="h-3 w-3"  />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto min-w-0 max-w-full p-3 text-xs leading-relaxed">
        <code className={className} {...props}>{children}</code>
      </pre>
    </div>
  );
}

const markdownComponents = {
  pre: ({ children }: any) => <div className="min-w-0 max-w-full my-1">{children}</div>,
  code: CodeBlock,
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="mb-2 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</p>
  ),
  ol: ({ children, ...props }: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</ol>
  ),
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</ul>
  ),
  li: ({ children, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className="text-sm break-words [overflow-wrap:anywhere]" {...props}>{children}</li>
  ),
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-foreground" {...props}>{children}</strong>
  ),
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</h3>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 className="mb-1.5 mt-2.5 text-sm font-semibold first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</h4>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h5 className="mb-1 mt-2 text-sm font-medium first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</h5>
  ),
  blockquote: ({ children, ...props }: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 italic text-muted-foreground break-words [overflow-wrap:anywhere]" {...props}>{children}</blockquote>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border max-w-full">
      <table className="w-full text-sm" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="border-b border-border bg-muted/50 px-3 py-1.5 text-left text-xs font-medium" {...props}>{children}</th>
  ),
  td: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border-b border-border px-3 py-1.5" {...props}>{children}</td>
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function modelLabel(model?: AiModel) {
  return model?.label || model?.id || "Select model";
}

function modelMode(model?: AiModel): AiMode {
  return model?.mode === "thinking" ? "thinking" : "fast";
}

function arrayFromResponse<T>(value: unknown, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key] as T[];
    }
  }

  return [];
}

function randomSecret(prefix = "StackPilot") {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function findApplicationIntent(message: string) {
  const normalized = message.toLowerCase();
  const template =
    agentApplicationTemplates.find((candidate) =>
      candidate.aliases.some((alias) => normalized.includes(alias))
    ) || null;
  if (!template) return null;

  const explicit =
    normalized.startsWith("/app ") ||
    /\b(deploy|create|provision|install|run|launch|spin up|start)\b/.test(normalized);
  return explicit ? template : null;
}

function conciseApplicationProjectName(template: AgentApplicationTemplate) {
  const names: Record<string, string> = {
    mysql: "MySQL",
    postgres: "PostgreSQL",
    redis: "Redis",
    mongo: "MongoDB",
    mariadb: "MariaDB",
    rabbitmq: "RabbitMQ",
    minio: "MinIO",
    grafana: "Grafana",
    prometheus: "Prometheus",
    adminer: "Adminer",
  };
  return names[template.id] || template.name;
}

export default function AiAgentPage() {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [messages, setMessages] = useState<ChatMessage[]>(starterMessages);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AiMode>("fast");
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("ai-default-model") || "";
  });
  const [pendingApproval, setPendingApproval] = useState<{
    id: string;
    type: "terminal" | "deploy";
    title: string;
    description: string;
    command?: string;
    action: () => Promise<void> | void;
    onDecline: () => void;
  } | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composerModelOpen, setComposerModelOpen] = useState(false);
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLogs, setTerminalLogs] = useState<TerminalExecutionLog[]>([]);
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [isTerminalExecuting, setIsTerminalExecuting] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState<string>("");
  const terminalLogsEndRef = useRef<HTMLDivElement>(null);
  const terminalInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const initDeploymentId = params.get("deploymentId");
      const initCommand = params.get("command");
      if (initDeploymentId) {
        setSelectedDeploymentId(initDeploymentId);
        if (initCommand === "repair") {
          setInput(`/repair ${initDeploymentId}`);
        }
      }
    }
  }, []);
  const [settingsModelOpen, setSettingsModelOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [provider, setProvider] = useState<AiProvider>("nvidia_nim");
  const [compatibleBaseUrl, setCompatibleBaseUrl] = useState("");
  const [compatibleApiKey, setCompatibleApiKey] = useState("");
  const [compatibleModel, setCompatibleModel] = useState("");
  const [nvidiaApiKey, setNvidiaApiKey] = useState("");
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [customModelList, setCustomModelList] = useState<AiModel[] | null>(null);
  const [agentAccessMode, setAgentAccessMode] = useState<"ask" | "auto_review" | "full_access">(() => {
    if (typeof window === "undefined") return "ask";
    const saved = window.localStorage.getItem("ai-agent-access-mode");
    return saved === "ask" || saved === "auto_review" || saved === "full_access" ? saved : "ask";
  });
  const [remoteTerminalPermission, setRemoteTerminalPermission] = useState<"ask" | "allow">(() => {
    if (typeof window === "undefined") return "ask";
    const saved = window.localStorage.getItem("ai-agent-remote-terminal");
    return saved === "ask" || saved === "allow" ? saved : "ask";
  });
  const [orbStyle, setOrbStyle] = useState<ThinkingOrbStyle>(() => {
    if (typeof window === "undefined") return "solving";
    const saved = window.localStorage.getItem("ai-thinking-orb-style");
    return (saved as ThinkingOrbStyle) || "solving";
  });
  const [isListening, setIsListening] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const baseTextRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const settingsHydratedRef = useRef(false);

  const settingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: async () => {
      const res = await api.get("/ai/settings");
      return res.data as AiSettingsResponse;
    },
  });

  const modelsQuery = useQuery({
    queryKey: ["ai-models"],
    queryFn: async () => {
      const res = await api.get("/ai/models", { timeout: AI_REQUEST_TIMEOUT_MS });
      return res.data as AiModelsResponse;
    },
  });

  const fetchModelsWithCurrentKey = async () => {
    setIsFetchingModels(true);
    try {
      const currentApiKey = provider === "nvidia_nim" ? nvidiaApiKey.trim() : compatibleApiKey.trim();
      const currentBaseUrl = provider === "openai_compatible" ? compatibleBaseUrl.trim() : undefined;
      const res = await api.post("/ai/models", {
        provider,
        api_key: currentApiKey || undefined,
        base_url: currentBaseUrl || undefined,
      });
      const data = res.data as AiModelsResponse;
      if (data?.models && Array.isArray(data.models)) {
        setCustomModelList(data.models);
        if (data.models.length > 0 && !selectedModel) {
          setSelectedModel(data.models[0].id);
        }
      }
    } catch {
      await modelsQuery.refetch();
    } finally {
      setIsFetchingModels(false);
    }
  };

  // These normalize to a bare array, whereas the dashboard and deployments pages
  // cache the raw {projects}/{deployments} object under the same base key. Sharing
  // the key made last-writer-wins corrupt whichever page read the other's shape.
  // The extra segment isolates the cache entry while still matching prefix
  // invalidation on ["projects"] / ["deployments"].
  const projectsQuery = useQuery({
    queryKey: ["projects", "ai-picker"],
    queryFn: async () => {
      const res = await api.get<unknown>("/projects");
      return arrayFromResponse<Project>(res.data, ["projects", "data", "items"]);
    },
  });

  const deploymentsQuery = useQuery({
    queryKey: ["deployments", "ai-picker"],
    queryFn: async () => {
      const res = await api.get<unknown>("/deployments");
      return arrayFromResponse<Deployment>(res.data, ["deployments", "data", "items"]);
    },
    refetchInterval: 8000,
  });

  const sessionsQuery = useQuery({
    queryKey: ["ai-chat-sessions"],
    queryFn: async () => {
      const res = await api.get("/ai/sessions");
      const data = res.data as { sessions?: AiChatSession[] };
      return data.sessions || [];
    },
    refetchInterval: 12000,
  });

  const rawDiscoveredModels = customModelList !== null ? customModelList : arrayFromResponse<AiModel>(modelsQuery.data?.models, []);
  const providerFallbackModels: AiModel[] =
    selectedModel
      ? [{ id: selectedModel, label: selectedModel, mode }]
      : [];
  const availableModels = rawDiscoveredModels.length > 0 ? rawDiscoveredModels : providerFallbackModels;
  const projects = arrayFromResponse<Project>(projectsQuery.data);
  const deployments = arrayFromResponse<Deployment>(deploymentsQuery.data);
  const sessions = sessionsQuery.data || [];
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const fastModels = availableModels.filter((model) => modelMode(model) === "fast");
  const thinkingModels = availableModels.filter((model) => modelMode(model) === "thinking");
  const modeModels = mode === "thinking" ? thinkingModels : fastModels;
  const selectedModelIsAvailable = availableModels.some((model) => model.id === selectedModel);
  const activeModelId =
    selectedModel ||
    (selectedModelIsAvailable ? selectedModel : "") ||
    modeModels[0]?.id ||
    availableModels[0]?.id ||
    modelsQuery.data?.selected_model ||
    "";
  const activeModel =
    availableModels.find((model) => model.id === activeModelId) ||
    (activeModelId ? { id: activeModelId, label: activeModelId, mode } : undefined);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedDeployment = deployments.find((deployment) => deployment.id === selectedDeploymentId);
  // A command with a trailing space is a command waiting for its argument.
  // Nobody remembers a project id, so the picker opens on its own and the
  // user chooses by name -- the id is filled in behind the scenes.
  const pendingCommand = useMemo(() => {
    const match = /^(\/[a-z]+)\s+$/i.exec(input);
    if (!match) return null;
    const entry = commands.find((command) => command.name === match[1].toLowerCase());
    if (!entry || entry.arg === "none" || entry.arg === "command") return null;
    return entry;
  }, [input]);

  const argPickerOpen = pendingCommand !== null;

  // Failed deployments first: a command that takes a deployment id is usually
  // being pointed at something broken.
  const pickableDeployments = deployments
    .slice()
    .sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  // Clicking anywhere outside the composer dismisses the command palette.
  // Previously it stayed open until something was chosen, which made a
  // mistyped "/" feel like the page had locked up.
  useEffect(() => {
    if (!showCommands) return;
    const onPointerDown = (event: MouseEvent) => {
      if (composerRef.current?.contains(event.target as Node)) return;
      setShowCommands(false);
    };
    // Escape is the other half of the same expectation.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowCommands(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showCommands]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  useEffect(() => {
    if (settingsHydratedRef.current || !settingsQuery.data) return;
    settingsHydratedRef.current = true;
    const handle = window.setTimeout(() => {
      setProvider(settingsQuery.data?.provider || "nvidia_nim");
      setCompatibleBaseUrl(settingsQuery.data?.openai_compatible_base_url || "");
      setCompatibleModel(settingsQuery.data?.model || "");
      const stored = typeof window !== "undefined" ? window.localStorage.getItem("ai-default-model") : "";
      if (stored) {
        setSelectedModel(stored);
      } else if (settingsQuery.data?.model) {
        setSelectedModel(settingsQuery.data.model);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("ai-default-model", settingsQuery.data.model);
        }
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [settingsQuery.data]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("ai-agent-access-mode", agentAccessMode);
    window.localStorage.setItem("ai-agent-remote-terminal", remoteTerminalPermission);
    window.localStorage.setItem("ai-thinking-orb-style", orbStyle);
    if (selectedModel) {
      window.localStorage.setItem("ai-default-model", selectedModel);
    }
  }, [agentAccessMode, remoteTerminalPermission, orbStyle, selectedModel]);

  const startListening = () => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      toast.error("Voice input is not supported in this browser. Please use Chrome, Edge, or Safari.");
      return;
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }

      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";

      baseTextRef.current = input;

      recognition.onstart = () => {
        setIsListening(true);
        toast.info("Voice input active. Speak into your microphone...");
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        let interimTranscript = "";
        let finalTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const item = event.results[i];
          if (item && item[0]) {
            if (item.isFinal) {
              finalTranscript += item[0].transcript;
            } else {
              interimTranscript += item[0].transcript;
            }
          }
        }

        const currentSpeech = (finalTranscript || interimTranscript).trim();
        if (currentSpeech) {
          const prefix = baseTextRef.current.trim();
          const combined = prefix ? `${prefix} ${currentSpeech}` : currentSpeech;
          setInput(combined);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onerror = (event: any) => {
        console.warn("Speech recognition error:", event.error);
        if (event.error === "not-allowed" || event.error === "permission-denied") {
          toast.error("Microphone permission denied. Please allow microphone access in your browser settings.");
        } else if (event.error !== "no-speech") {
          toast.error(`Voice recognition error: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.error("Failed to start speech recognition:", err);
      toast.error("Could not start microphone.");
      setIsListening(false);
    }
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }
    setIsListening(false);
  };

  const toggleListening = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
    };
  }, []);

  const chooseModel = (model: AiModel) => {
    setSelectedModel(model.id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("ai-default-model", model.id);
    }
    setMode(modelMode(model));
    if (provider === "openai_compatible") {
      setCompatibleModel(model.id);
    }
  };

  const openTerminalWithCommand = (command?: string) => {
    setTerminalOpen(true);
    if (command) {
      setTerminalInput(command);
    }
    setTimeout(() => {
      terminalInputRef.current?.focus();
    }, 100);
  };

  const runTerminalCommand = async (cmdToRun: string) => {
    const trimmed = cmdToRun.trim();
    if (!trimmed || isTerminalExecuting) return;

    setTerminalHistory((prev) => [...prev.filter((c) => c !== trimmed), trimmed]);
    setHistoryIndex(-1);
    setTerminalInput("");

    const execId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timestamp = new Date().toLocaleTimeString();

    const newLog: TerminalExecutionLog = {
      id: execId,
      command: trimmed,
      timestamp,
      status: "running",
    };

    setTerminalLogs((prev) => [...prev, newLog]);
    setIsTerminalExecuting(true);

    try {
      const res = await api.post("/ai/tools/execute", {
        tool_name: "terminal_run_command",
        arguments: {
          command: trimmed,
          ...(selectedDeploymentId ? { deployment_id: selectedDeploymentId } : {}),
          ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
        },
      });

      const data = (res.data || {}) as Record<string, any>;
      const exitCode = typeof data.exit_code === "number" ? data.exit_code : (data.error ? 1 : 0);
      const stdout = typeof data.stdout === "string" ? data.stdout : (exitCode === 0 && typeof data.output === "string" ? data.output : "");
      const stderr = typeof data.stderr === "string" ? data.stderr : (exitCode !== 0 ? (typeof data.output === "string" ? data.output : typeof data.error === "string" ? data.error : "") : "");
      const cwd = typeof data.cwd === "string" ? data.cwd : typeof data.working_directory === "string" ? data.working_directory : undefined;
      if (cwd) {
        setTerminalCwd(cwd);
      }

      setTerminalLogs((prev) =>
        prev.map((item) =>
          item.id === execId
            ? {
                ...item,
                status: exitCode === 0 ? "success" : "error",
                exitCode,
                stdout: stdout || undefined,
                stderr: stderr || undefined,
                cwd,
              }
            : item
        )
      );
    } catch (err: any) {
      const errMessage = err.response?.data?.error || err.message || "Execution failed";
      setTerminalLogs((prev) =>
        prev.map((item) =>
          item.id === execId
            ? {
                ...item,
                status: "error",
                exitCode: 1,
                stderr: errMessage,
              }
            : item
        )
      );
    } finally {
      setIsTerminalExecuting(false);
      setTimeout(() => {
        terminalInputRef.current?.focus();
      }, 50);
    }
  };

  const handleTerminalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (terminalHistory.length === 0) return;
      const nextIndex = historyIndex === -1 ? terminalHistory.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setTerminalInput(terminalHistory[nextIndex] || "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === -1) return;
      if (historyIndex < terminalHistory.length - 1) {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        setTerminalInput(terminalHistory[nextIndex] || "");
      } else {
        setHistoryIndex(-1);
        setTerminalInput("");
      }
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runTerminalCommand(terminalInput);
    }
  };

  useEffect(() => {
    if (terminalOpen) {
      terminalLogsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [terminalLogs, terminalOpen]);

  const closePickers = () => {
    setComposerModelOpen(false);
    setCommandPickerOpen(false);
    setSettingsModelOpen(false);
    setProjectOpen(false);
    setDeploymentOpen(false);
  };

  const appendMessage = (message: Omit<ChatMessage, "id">) => {
    setMessages((current) => [
      ...current,
      {
        ...message,
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
    ]);
  };

  const startNewChat = () => {
    setActiveSessionId("");
    setMessages(starterMessages);
    setPendingApproval(null);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/dashboard/ai");
      const defaultModel = window.localStorage.getItem("ai-default-model");
      if (defaultModel) {
        setSelectedModel(defaultModel);
      }
    }
  };

  const loadSession = async (sessionId: string) => {
    const res = await api.get(`/ai/sessions/${sessionId}`);
    const data = res.data as { session?: AiChatSession; messages?: AiChatMessage[] };
    setActiveSessionId(sessionId);
    setPendingApproval(null);
    if (data.session?.last_model) {
      setSelectedModel(data.session.last_model);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("ai-default-model", data.session.last_model);
      }
    }
    setMessages(
      (data.messages || [])
        .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
        .map((message) => {
          const meta = (message.metadata || {}) as Record<string, any>;
          const usage = (meta.token_usage || {}) as Record<string, number>;
          return {
            id: message.id,
            role: message.role as Role,
            content: message.content,
            reasoning: typeof meta.reasoning === "string" && meta.reasoning.trim() ? meta.reasoning : undefined,
            toolCalls: Array.isArray(meta.tool_calls) && meta.tool_calls.length > 0 ? meta.tool_calls : undefined,
            stats: {
              latencyMs: typeof meta.latency_ms === "number" ? meta.latency_ms : undefined,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
              model: typeof meta.model === "string" ? meta.model : undefined,
              provider: typeof meta.provider === "string" ? meta.provider : undefined,
              traceId: typeof meta.trace_id === "string" ? meta.trace_id : undefined,
            },
          };
        })
    );
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `/dashboard/ai?session_id=${sessionId}`);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined" || activeSessionId) return;
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (sessionId) {
      const handle = window.setTimeout(() => {
        loadSession(sessionId).catch(() => {
          setMessages([
            ...starterMessages,
            {
              id: `session-load-error-${Date.now()}`,
              role: "assistant",
              content: "I could not load that chat. It may have been deleted or belongs to another account.",
              meta: "Error",
            },
          ]);
        });
      }, 0);
      return () => window.clearTimeout(handle);
    }
  }, [activeSessionId]);

  const deployApplicationTemplate = async (template: AgentApplicationTemplate) => {
    const password = randomSecret(template.id);
    const rootPassword = randomSecret(`${template.id}_root`);
    const config = template.config(password, rootPassword);
    const projectName = conciseApplicationProjectName(template);

    const projectRes = await api.post("/projects", {
      name: projectName,
      description: `Created from AI chat request for ${template.name}.`,
      source_type: "application",
      application_template_id: template.id,
      application_config: config,
      source_path: "",
      execution_mode: "local",
      remote_runtime_type: "docker",
      remote_k8s_exposure: "nodeport",
      runtime_scheme: "http",
      local_https_enabled: false,
      env_vars: [],
    });
    const projectId = projectRes.data?.project?.id as string | undefined;
    if (!projectId) {
      throw new Error("Application project was created but the API did not return a project id.");
    }

    const deploymentRes = await api.post(`/projects/${projectId}/deployments`, {
      version: "v-ai-app",
      commit_hash: "",
    });
    const deploymentId = deploymentRes.data?.deployment?.id as string | undefined;
    if (!deploymentId) {
      throw new Error("Application deployment was created but the API did not return a deployment id.");
    }

    const triggerRes = await api.post(`/deployments/${deploymentId}/trigger`);
    return {
      projectName,
      projectId,
      deploymentId,
      config,
      triggerMessage: triggerRes.data?.message || "Build queued.",
    };
  };

  const shouldAttachDeploymentContext = (text: string) => {
    if (!selectedDeploymentId) return false;
    const normalized = text.toLowerCase();
    return (
      normalized.startsWith("/diagnose") ||
      /\b(failed|failure|error|logs?|diagnose|debug|why|fix|runtime|health|crash|port|container|compose|kubernetes|deploy|build)\b/.test(
        normalized
      )
    );
  };

  const runAgentMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await api.post(
        "/ai/chat",
        {
          message,
          command: message.startsWith("/") ? message.split(/\s+/)[0] : "",
          model: activeModelId,
          model_mode: mode,
          session_id: activeSessionId || undefined,
          project_id: selectedProjectId,
          deployment_id: shouldAttachDeploymentContext(message) ? selectedDeploymentId : "",
          runtime: {
            permissions: {
              agent_access_mode: agentAccessMode,
              remote_terminal: remoteTerminalPermission,
              require_confirmation: agentAccessMode !== "full_access",
            },
          },
          history: messages.slice(-8).map((item) => ({ role: item.role, content: sanitizeHistoryContent(item.content) })),
        },
        { timeout: AI_REQUEST_TIMEOUT_MS }
      );
      return res.data as AiResponse;
    },
    onMutate: () => {
      window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
      }, 700);
    },
    onSuccess: (result) => {
      if (result.session_id && result.session_id !== activeSessionId) {
        setActiveSessionId(result.session_id);
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", `/dashboard/ai?session_id=${result.session_id}`);
        }
      }
      const usage = (result.token_usage || {}) as Record<string, number>;
      appendMessage({
        role: "assistant",
        content: formatAiOutput(result),
        reasoning: typeof result.reasoning === "string" ? result.reasoning : "",
        stats: {
          latencyMs: result.latency_ms,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          confidence: result.confidence,
          model: result.model || activeModelId,
          provider: result.provider,
          traceId: result.trace_id,
        },
      });
      queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
      sessionsQuery.refetch();
    },
    onError: (error) => {
      appendMessage({ role: "assistant", content: errorMessage(error, "Agent chat failed."), meta: "Error" });
    },
  });

  const commandMutation = useMutation({
    mutationFn: async (raw: string) => {
      const trimmed = raw.trim();
      const uuidMatch = trimmed.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      const parsedUuid = uuidMatch ? uuidMatch[0] : "";
      const tokens = trimmed.split(/\s+/);
      const command = tokens[0]?.toLowerCase();
      const firstArg = tokens[1];
      const secondArg = tokens[2];
      const targetDeploymentId = parsedUuid || (firstArg && !firstArg.startsWith("/") && firstArg.length > 8 ? firstArg : selectedDeploymentId);
      const targetProjectId = parsedUuid || (firstArg && !firstArg.startsWith("/") && firstArg.length > 8 ? firstArg : selectedProjectId);

      // Extract custom user prompt/question after command and UUID
      let customUserPrompt = trimmed.replace(new RegExp(`^${command}\\b`, "i"), "").trim();
      if (parsedUuid) {
        customUserPrompt = customUserPrompt.replace(parsedUuid, "").trim();
      } else if (firstArg && (firstArg === targetProjectId || firstArg === targetDeploymentId)) {
        customUserPrompt = customUserPrompt.replace(firstArg, "").trim();
      }

      // ── platform capability commands ───────────────────────────
      // Each wraps an endpoint the backend already access-gates via
      // has_project_access(), so an unauthorised caller gets a 404/403 from
      // the server rather than being filtered here.

      if (command === "/cost") {
        const days = Number.parseInt(firstArg || "30", 10) || 30;
        const res = await api.get(`/cost?days=${days}`);
        const report = res.data;
        const rows = (report.projects || [])
          .filter((p: { millicents: number }) => p.millicents > 0)
          .map(
            (p: { project_name: string; formatted: string; deployments: number }) =>
              `  ${p.project_name}: ${p.formatted} (${p.deployments} deployment${p.deployments === 1 ? "" : "s"})`
          );
        return {
          title: `Cost, last ${report.window_days} day${report.window_days === 1 ? "" : "s"}`,
          body:
            `Total: ${report.total_formatted}\nPreview environments: ${report.preview_formatted}\n\n` +
            (rows.length ? rows.join("\n") : "  Nothing has accrued yet — cost starts once a deployment runs.") +
            `\n\n${report.note || ""}`,
        };
      }

      if (command === "/drift") {
        if (!targetDeploymentId) throw new Error("Usage: /drift <deployment-id>");
        const res = await api.get(`/deployments/${targetDeploymentId}/drift`);
        const report = res.data;
        if (report.status === "unreachable") {
          return {
            title: "Drift unknown",
            body: "Could not read live state from the runtime. This is not the same as 'no drift' — the deployment has not been confirmed healthy.",
          };
        }
        if (!report.drifted) {
          return { title: "No drift", body: "Live state matches what StackPilot recorded." };
        }
        const findings = (report.findings || [])
          .map(
            (f: { severity: string; field: string; desired: string; actual: string; detail: string }) =>
              `  [${f.severity}] ${f.field}\n      recorded: ${f.desired}\n      live:     ${f.actual}\n      ${f.detail}`
          )
          .join("\n\n");
        return { title: report.summary, body: findings };
      }

      if (command === "/secrets") {
        const path = targetProjectId ? `/projects/${targetProjectId}/secrets` : "/secrets";
        const res = await api.get(path);
        const secrets = res.data.secrets || res.data || [];
        return {
          title: `${secrets.length} secret${secrets.length === 1 ? "" : "s"}`,
          body: secrets.length
            ? "Keys only — values are never returned by a list.\n\n" +
              secrets
                .map((s: { key: string; version?: number }) => `  ${s.key} (v${s.version || 1})`)
                .join("\n")
            : "No secrets stored.",
        };
      }

      if (command === "/scale") {
        if (!targetDeploymentId) throw new Error("Usage: /scale <deployment-id> <replicas>");
        const replicas = Number.parseInt(secondArg || "", 10);
        if (Number.isNaN(replicas) || replicas < 0 || replicas > 50) {
          throw new Error("Usage: /scale <deployment-id> <replicas>  (0-50)");
        }
        const res = await api.post(`/deployments/${targetDeploymentId}/kubernetes/scale`, { replicas });
        return {
          title: `Scaled to ${replicas}`,
          body: `${shortId(targetDeploymentId)} now targets ${replicas} replica${replicas === 1 ? "" : "s"}.\n${res.data.message || ""}`,
        };
      }

      if (command === "/rollback") {
        if (!targetDeploymentId) throw new Error("Usage: /rollback <deployment-id>");
        const res = await api.post(`/deployments/${targetDeploymentId}/kubernetes/rollback`, {});
        return {
          title: "Rollback requested",
          body: `${shortId(targetDeploymentId)} is rolling back to its previous revision.\n${res.data.message || ""}`,
        };
      }

      if (command === "/pause" || command === "/resume") {
        if (!targetDeploymentId) throw new Error(`Usage: ${command} <deployment-id>`);
        const action = command === "/pause" ? "pause" : "resume";
        const res = await api.post(`/deployments/${targetDeploymentId}/runtime/${action}`, {});
        return {
          title: action === "pause" ? "Runtime paused" : "Runtime resumed",
          body: `${shortId(targetDeploymentId)}: ${res.data.message || `${action}d`}.`,
        };
      }

      if (command === "/events") {
        if (!targetDeploymentId) throw new Error("Usage: /events <deployment-id>");
        const res = await api.get(`/deployments/${targetDeploymentId}/kubernetes/events`);
        return {
          title: "Kubernetes events",
          body: res.data.events || res.data.logs || "No events returned.",
        };
      }

      if (command === "/metrics") {
        if (!targetDeploymentId) throw new Error("Usage: /metrics <deployment-id>");
        const res = await api.get(`/deployments/${targetDeploymentId}/metrics`);
        return { title: "Deployment metrics", body: JSON.stringify(res.data, null, 2) };
      }

      if (command === "/org") {
        const res = await api.get("/organizations");
        const orgs = res.data.organizations || [];
        return {
          title: `${orgs.length} organization${orgs.length === 1 ? "" : "s"}`,
          body: orgs
            .map(
              (o: { name: string; slug: string; role: string; member_count: number; is_personal: boolean }) =>
                `  ${o.name} (${o.slug}) — you are ${o.role}, ${o.member_count} member${o.member_count === 1 ? "" : "s"}${o.is_personal ? " [personal]" : ""}`
            )
            .join("\n"),
        };
      }

      if (command === "/environments") {
        if (!targetProjectId) throw new Error("Usage: /environments <project-id>");
        const res = await api.get(`/projects/${targetProjectId}/environments`);
        const envs = res.data.environments || res.data || [];
        return {
          title: `${envs.length} environment${envs.length === 1 ? "" : "s"}`,
          body: envs.length
            ? envs
                .map(
                  (e: { name: string; branch?: string; auto_deploy?: boolean; require_ci?: boolean }) =>
                    `  ${e.name} — branch ${e.branch || "(none)"}, auto-deploy ${e.auto_deploy ? "on" : "off"}, CI required ${e.require_ci ? "yes" : "no"}`
                )
                .join("\n")
            : "No environments configured.",
        };
      }

      if (command === "/repair" || command === "/fix") {
        if (!targetDeploymentId) throw new Error("Usage: /repair <deployment-id> [instructions]");
        const res = await api.post(`/deployments/${targetDeploymentId}/ai/repair`, {
          model: activeModelId,
          model_mode: mode,
          message: customUserPrompt || undefined,
          problem_description: customUserPrompt || undefined,
        }, { timeout: 120000 });
        const data = res.data;
        const changes = (data.applied_changes || [])
          .map((c: { path: string; description: string; action: string }) => `  • [${c.action || 'modify'}] \`${c.path}\` — ${c.description || 'Updated'}`)
          .join('\n');
        const usage = (data.token_usage || {}) as Record<string, number>;
        const repairToolCalls: ToolCall[] = (data.applied_changes || []).map((c: any) => ({
          name: c.action === "create" ? "workspace_write_file" : "workspace_edit_file",
          arguments: { path: c.path, description: c.description, action: c.action },
          result: { status: "applied", path: c.path },
        }));
        return {
          title: "AI Auto-Fix & Repair Complete",
          body: `### Root Cause\n${data.structured_output?.root_cause || data.summary || "Identified configuration / build issues"}\n\n### Applied Fixes:\n${changes || "  • Auto-patched build configurations"}\n\n**New Deployment Queued:** ${data.new_deployment_id ? `\`${data.new_deployment_id}\`` : "In Progress"}`,
          reasoning: typeof data.reasoning === "string" ? data.reasoning : (typeof data.structured_output?.root_cause === "string" ? data.structured_output.root_cause : ""),
          toolCalls: repairToolCalls.length > 0 ? repairToolCalls : undefined,
          stats: {
            latencyMs: data.latency_ms,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            confidence: data.confidence,
            model: data.model || activeModelId,
            provider: data.provider,
            traceId: data.trace_id,
          },
        };
      }

      if (command === "/build") {
        if (!targetDeploymentId) throw new Error("Usage: /build <deployment-id>");
        const res = await api.post(`/deployments/${targetDeploymentId}/trigger`);
        return {
          title: "Build queued",
          body: `Deployment ${shortId(targetDeploymentId)} is queued for the worker.\n${res.data.message || ""}`,
        };
      }

      if (command === "/deploy") {
        if (!targetDeploymentId) throw new Error("Usage: /deploy <deployment-id> [port]");
        const extraText = trimmed.replace(new RegExp(`^${command}`, "i"), "").replace(targetDeploymentId, "").trim();
        if (extraText.length > 5 && !/^\d+$/.test(extraText)) {
          // Problem description or instructions provided with /deploy
          const res = await api.post(`/deployments/${targetDeploymentId}/ai/repair`, {
            model: activeModelId,
            model_mode: mode,
            message: extraText,
            problem_description: extraText,
          }, { timeout: 120000 });
          const data = res.data;
          const changes = (data.applied_changes || [])
            .map((c: { path: string; description: string; action: string }) => `  • [${c.action || 'modify'}] \`${c.path}\` — ${c.description || 'Updated'}`)
            .join('\n');
          const usage = (data.token_usage || {}) as Record<string, number>;
          const repairToolCalls: ToolCall[] = (data.applied_changes || []).map((c: any) => ({
            name: c.action === "create" ? "workspace_write_file" : "workspace_edit_file",
            arguments: { path: c.path, description: c.description, action: c.action },
            result: { status: "applied", path: c.path },
          }));
          return {
            title: "AI Auto-Fix & Deploy",
            body: `### Diagnosed Issue\n${data.structured_output?.root_cause || data.summary || "Identified configuration and runtime issues"}\n\n### Applied Changes:\n${changes || "  • Resolved container & port conflicts"}\n\n**New Clean Deployment Started:** ${data.new_deployment_id ? `\`${data.new_deployment_id}\`` : "Queued"}`,
            reasoning: typeof data.reasoning === "string" ? data.reasoning : (typeof data.structured_output?.root_cause === "string" ? data.structured_output.root_cause : ""),
            toolCalls: repairToolCalls.length > 0 ? repairToolCalls : undefined,
            stats: {
              latencyMs: data.latency_ms,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
              confidence: data.confidence,
              model: data.model || activeModelId,
              provider: data.provider,
              traceId: data.trace_id,
            },
          };
        }

        try {
          const port = Number.parseInt(secondArg || "3000", 10) || 3000;
          const res = await api.post(`/deployments/${targetDeploymentId}/kubernetes/deploy`, {
            namespace: "stackpilot-apps",
            exposure_mode: "nodeport",
            replicas: 1,
            container_port: port,
            resource_preset: "small",
            health_path: "/",
          });
          return {
            title: "Deploy started",
            body: `Kubernetes deploy started for ${shortId(targetDeploymentId)} on port ${port}.\n${res.data.message || ""}`,
          };
        } catch {
          const triggerRes = await api.post(`/deployments/${targetDeploymentId}/trigger`);
          return {
            title: "Deployment build queued",
            body: `Triggered deployment build for ${shortId(targetDeploymentId)}.\n${triggerRes.data.message || ""}`,
          };
        }
      }

      if (command === "/diagnose") {
        if (!targetDeploymentId) throw new Error("Usage: /diagnose <deployment-id> [details]");
        const deployment = deployments.find((item) => item.id === targetDeploymentId);
        const logs = await api.get(`/deployments/${targetDeploymentId}/logs`);
        const useRuntime = deployment?.image_name && deployment.status !== "failed";
        const res = useRuntime
          ? await api.post(`/deployments/${targetDeploymentId}/ai/analyze-runtime`, {
              model: activeModelId,
              model_mode: mode,
              message: customUserPrompt || undefined,
              runtime: {
                status: deployment.status,
                runtime_url: deployment.runtime_url,
              },
            }, { timeout: AI_REQUEST_TIMEOUT_MS })
          : await api.post(`/deployments/${targetDeploymentId}/ai/analyze-build-failure`, {
              model: activeModelId,
              model_mode: mode,
              message: customUserPrompt || undefined,
              logs: logs.data?.deployment?.logs || "",
            }, { timeout: AI_REQUEST_TIMEOUT_MS });
        const diagData = res.data as AiResponse;
        const diagUsage = (diagData.token_usage || {}) as Record<string, number>;
        return {
          title: "Diagnosis",
          body: formatAiOutput(diagData),
          reasoning: typeof diagData.reasoning === "string" ? diagData.reasoning : "",
          stats: {
            latencyMs: diagData.latency_ms,
            promptTokens: diagUsage.prompt_tokens,
            completionTokens: diagUsage.completion_tokens,
            totalTokens: diagUsage.total_tokens,
            confidence: diagData.confidence,
            model: diagData.model || activeModelId,
            provider: diagData.provider,
            traceId: diagData.trace_id,
          },
        };
      }

      if (command === "/dockerfile") {
        if (!targetProjectId) throw new Error("Usage: /dockerfile <project-id> [requirements]");
        const res = await api.post(`/projects/${targetProjectId}/ai/dockerfile`, {
          model: activeModelId,
          model_mode: mode,
          message: customUserPrompt || undefined,
        }, { timeout: AI_REQUEST_TIMEOUT_MS });
        const dfData = res.data as AiResponse;
        const dfUsage = (dfData.token_usage || {}) as Record<string, number>;
        return {
          title: "Dockerfile plan",
          body: formatAiOutput(dfData),
          reasoning: typeof dfData.reasoning === "string" ? dfData.reasoning : "",
          stats: {
            latencyMs: dfData.latency_ms,
            promptTokens: dfUsage.prompt_tokens,
            completionTokens: dfUsage.completion_tokens,
            totalTokens: dfUsage.total_tokens,
            confidence: dfData.confidence,
            model: dfData.model || activeModelId,
            provider: dfData.provider,
            traceId: dfData.trace_id,
          },
        };
      }

      if (command === "/analyze") {
        if (!targetProjectId) throw new Error("Usage: /analyze <project-id> [instructions]");
        const res = await api.post(`/projects/${targetProjectId}/ai/analyze`, {
          model: activeModelId,
          model_mode: mode,
          message: customUserPrompt || undefined,
        }, { timeout: AI_REQUEST_TIMEOUT_MS });
        const anData = res.data as AiResponse;
        const anUsage = (anData.token_usage || {}) as Record<string, number>;
        return {
          title: "Project Analysis",
          body: formatAiOutput(anData),
          reasoning: typeof anData.reasoning === "string" ? anData.reasoning : "",
          stats: {
            latencyMs: anData.latency_ms,
            promptTokens: anUsage.prompt_tokens,
            completionTokens: anUsage.completion_tokens,
            totalTokens: anUsage.total_tokens,
            confidence: anData.confidence,
            model: anData.model || activeModelId,
            provider: anData.provider,
            traceId: anData.trace_id,
          },
        };
      }

      if (command === "/app") {
        const template = agentApplicationTemplates.find((item) =>
          item.id === firstArg?.toLowerCase() || item.aliases.includes((firstArg || "").toLowerCase())
        );
        if (!template) {
          throw new Error("Usage: /app mysql | postgres | redis | mongo | mariadb | rabbitmq | minio | grafana | prometheus | adminer");
        }
        if (agentAccessMode !== "full_access") {
          setPendingApproval({
            id: `deploy-app-${Date.now()}`,
            type: "deploy",
            title: `Deploy ${template.name}`,
            description: `Agent requested permission to create and deploy ${template.name} container with local Compose runtime and generated credentials.`,
            command: `/app ${template.id}`,
            action: async () => {
              const result = await deployApplicationTemplate(template);
              appendMessage({
                role: "assistant",
                content:
                  `Created ${result.projectName} and queued deployment ${shortId(result.deploymentId)}.\n\n` +
                  `Expected local endpoint: localhost:${preferredApplicationEndpointPort(result.config, template.defaultPort)}\n\n` +
                  `**Configuration**\n${safeApplicationSummary(template, result.config).map((line) => `- ${line}`).join("\n")}\n\n` +
                  `${result.triggerMessage}`,
                meta: "Application deploy started",
              });
              deploymentsQuery.refetch();
            },
            onDecline: () => {
              appendMessage({
                role: "assistant",
                content: `Deployment of **${template.name}** was declined by user.`,
                meta: "Action Declined",
              });
            },
          });
          return {
            title: "Approval Required",
            body: `I prepared the deployment plan for **${template.name}**. Please review and click **Accept & Run** or **Decline** below to proceed.`,
          };
        }
        const result = await deployApplicationTemplate(template);
        return {
          title: "Application deploy started",
          body:
            `Created ${result.projectName} and queued deployment ${shortId(result.deploymentId)}.\n\n` +
            `Expected local endpoint: localhost:${preferredApplicationEndpointPort(result.config, template.defaultPort)}\n\n` +
            `**Configuration**\n${safeApplicationSummary(template, result.config).map((line) => `- ${line}`).join("\n")}\n\n` +
            `${result.triggerMessage}`,
        };
      }

      if (command === "/help") {
        return {
          title: "Commands",
          body: commands.map((item) => `${item.usage} - ${item.description}`).join("\n"),
        };
      }

      // Unrecognized slash command: seamlessly route to AI streaming agent
      void sendStreaming(raw);
      return null;
    },
    onSuccess: (result) => {
      if (!result) return;
      appendMessage({
        role: "assistant",
        content: result.body,
        meta: result.title,
        reasoning: result.reasoning,
        toolCalls: (result as any).toolCalls,
        stats: result.stats,
      });
      deploymentsQuery.refetch();
    },
    onError: (error) => {
      appendMessage({
        role: "assistant",
        content: error instanceof Error ? error.message : errorMessage(error, "Command failed."),
        meta: "Command error",
      });
    },
  });

  const findProjectForText = (text: string) => {
    if (selectedProject) return selectedProject;
    const normalized = text.toLowerCase();
    return projects.find((project) => normalized.includes(project.name.toLowerCase()));
  };

  const isDeployIntent = (text: string) => {
    const normalized = text.toLowerCase();
    // The question guard MUST run before the template match. Previously
    // findApplicationIntent returned true unconditionally first, so
    // "How do I run a redis cache in production?" matched the redis template and
    // was routed to autonomous provisioning — creating a project, credentials and
    // a real build in response to a question.
    if (/\b(what|how|why|can|could|would|should|explain|tell me|help)\b/.test(normalized)) {
      return false;
    }
    if (normalized.trim().endsWith("?")) {
      return false;
    }
    if (findApplicationIntent(text)) return true;
    const hasActionVerb = /\b(deploy|redeploy|ship|release)\b/.test(normalized);
    if (!hasActionVerb) return false;
    if (/\b(this|current|selected|project|deployment|app|application)\b/.test(normalized)) {
      return Boolean(selectedProject || findProjectForText(text));
    }
    return Boolean(findProjectForText(text));
  };

  const autonomousDeployMutation = useMutation({
    mutationFn: async (message: string) => {
      const applicationTemplate = findApplicationIntent(message);
      if (applicationTemplate) {
        if (agentAccessMode !== "full_access") {
          setPendingApproval({
            id: `deploy-app-${Date.now()}`,
            type: "deploy",
            title: `Deploy ${applicationTemplate.name}`,
            description: `Agent requested permission to create and deploy ${applicationTemplate.name} container with local Compose runtime and generated credentials.`,
            command: `/app ${applicationTemplate.id}`,
            action: async () => {
              const result = await deployApplicationTemplate(applicationTemplate);
              appendMessage({
                role: "assistant",
                content:
                  `I created ${result.projectName} and queued deployment ${shortId(result.deploymentId)}.\n\n` +
                  `Expected local endpoint: localhost:${preferredApplicationEndpointPort(result.config, applicationTemplate.defaultPort)}\n\n` +
                  `**Configuration**\n${safeApplicationSummary(applicationTemplate, result.config).map((line) => `- ${line}`).join("\n")}\n\n` +
                  `The deployment will move to running after Docker Compose finishes starting the service. ${result.triggerMessage}`,
                meta: "Application deploy started",
              });
              deploymentsQuery.refetch();
            },
            onDecline: () => {
              appendMessage({
                role: "assistant",
                content: `Deployment of **${applicationTemplate.name}** was declined by user.`,
                meta: "Action Declined",
              });
            },
          });
          return {
            title: "Approval Required",
            body: `I prepared the deployment plan for **${applicationTemplate.name}**. Please review and click **Accept & Run** or **Decline** below to proceed.`,
          };
        }

        const result = await deployApplicationTemplate(applicationTemplate);
        return {
          title: "Application deploy started",
          body:
            `I created ${result.projectName} and queued deployment ${shortId(result.deploymentId)}.\n\n` +
            `Expected local endpoint: localhost:${preferredApplicationEndpointPort(result.config, applicationTemplate.defaultPort)}\n\n` +
            `**Configuration**\n${safeApplicationSummary(applicationTemplate, result.config).map((line) => `- ${line}`).join("\n")}\n\n` +
            "The deployment will move to running after Docker Compose finishes starting the service. " +
            `${result.triggerMessage}`,
        };
      }

      const project = findProjectForText(message);
      if (!project) {
        return {
          title: "Permission needed",
          body:
            "I can deploy for you, but I need a project context first. Select a project in Agent Settings or mention the exact project name.",
        };
      }

      if (agentAccessMode !== "full_access") {
        setPendingApproval({
          id: `deploy-proj-${Date.now()}`,
          type: "deploy",
          title: `Deploy ${project.name}`,
          description: `Agent requested permission to create a deployment for project "${project.name}", inspect/build source, and queue the build.`,
          command: `/deploy ${project.id}`,
          action: async () => {
            const createRes = await api.post(`/projects/${project.id}/deployments`, {
              version: "v-ai",
              commit_hash: "",
            });
            const deploymentId = createRes.data?.deployment?.id as string | undefined;
            if (!deploymentId) {
              throw new Error("Deployment was created but the API did not return a deployment id.");
            }
            const triggerRes = await api.post(`/deployments/${deploymentId}/trigger`);
            appendMessage({
              role: "assistant",
              content:
                `I created deployment ${shortId(deploymentId)} for ${project.name} and queued the build.\n\n` +
                "During the build, the worker will inspect the source tree and use deterministic generators first. If no deterministic generator can classify the project, AI scans the actual files and creates the Dockerfile fallback.\n\n" +
                `${triggerRes.data?.message || "Build queued."}`,
              meta: "Deployment Started",
            });
            deploymentsQuery.refetch();
          },
          onDecline: () => {
            appendMessage({
              role: "assistant",
              content: `Deployment for **${project.name}** was declined by user.`,
              meta: "Action Declined",
            });
          },
        });
        return {
          title: "Approval Required",
          body: `I prepared the deployment plan for **${project.name}**. Please review and click **Accept & Run** or **Decline** below to proceed.`,
        };
      }

      const createRes = await api.post(`/projects/${project.id}/deployments`, {
        version: "v-ai",
        commit_hash: "",
      });
      const deploymentId = createRes.data?.deployment?.id as string | undefined;
      if (!deploymentId) {
        throw new Error("Deployment was created but the API did not return a deployment id.");
      }
      const triggerRes = await api.post(`/deployments/${deploymentId}/trigger`);
      return {
          title: "Autonomous deploy started",
          body:
            `I created deployment ${shortId(deploymentId)} for ${project.name} and queued the build.\n\n` +
          "During the build, the worker will inspect the source tree and use deterministic generators first. If no deterministic generator can classify the project, AI scans the actual files and creates the Dockerfile fallback.\n\n" +
          `${triggerRes.data?.message || "Build queued."}`,
      };
    },
    onSuccess: (result) => {
      appendMessage({ role: "assistant", content: result.body, meta: result.title });
      deploymentsQuery.refetch();
    },
    onError: (error) => {
      appendMessage({
        role: "assistant",
        content: error instanceof Error ? error.message : errorMessage(error, "Autonomous deploy failed."),
        meta: "Agent action error",
      });
    },
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        enabled: true,
        provider,
        model: selectedModel || compatibleModel || activeModelId,
      };
      if (provider === "openai_compatible") {
        payload.openai_compatible_base_url = compatibleBaseUrl.trim();
        if (compatibleApiKey.trim()) {
          payload.openai_compatible_api_key = compatibleApiKey.trim();
        }
      } else {
        if (nvidiaApiKey.trim()) {
          payload.nvidia_api_key = nvidiaApiKey.trim();
        }
      }
      const res = await api.put("/ai/settings", payload);
      return res.data as { success?: boolean };
    },
    onSuccess: () => {
      setCompatibleApiKey("");
      setNvidiaApiKey("");
      settingsQuery.refetch();
      modelsQuery.refetch();
    },
  });

  // Live stream state. Kept separate from `messages` so a partial reply is
  // never mistaken for a finished one -- it is rendered as its own transient
  // bubble and only committed on the done frame.
  // On by default: watching the answer form is the whole point. Off is for
  // when someone wants the single atomic reply the blocking path gives.
  const [streamingEnabled, setStreamingEnabled] = useState(true);
  const [streamReasoning, setStreamReasoning] = useState("");
  const [streamContent, setStreamContent] = useState("");
  const [streamToolCalls, setStreamToolCalls] = useState<ToolCall[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (isStreaming) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [streamReasoning, streamToolCalls, streamContent, isStreaming]);

  const sendStreaming = async (prompt: string) => {
    // Extract UUID and slash command
    const uuidMatch = prompt.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    const parsedUuid = uuidMatch ? uuidMatch[0] : "";
    const commandMatch = prompt.match(/^\/([a-zA-Z0-9_-]+)/);
    const parsedCommand = commandMatch ? commandMatch[0].toLowerCase() : "";

    const isDeploymentTarget =
      deployments.some((d) => d.id === parsedUuid) ||
      parsedCommand === "/repair" ||
      parsedCommand === "/diagnose" ||
      parsedCommand === "/fix" ||
      parsedCommand === "/deploy";
    const targetDeploymentId = (parsedUuid && isDeploymentTarget) ? parsedUuid : (selectedDeploymentId || undefined);
    const targetProjectId = (parsedUuid && !isDeploymentTarget) ? parsedUuid : (selectedProjectId || undefined);

    if (parsedUuid && isDeploymentTarget && parsedUuid !== selectedDeploymentId) {
      setSelectedDeploymentId(parsedUuid);
      const matchedDep = deployments.find((d) => d.id === parsedUuid);
      if (matchedDep?.project_id && matchedDep.project_id !== selectedProjectId) {
        setSelectedProjectId(matchedDep.project_id);
      }
    } else if (parsedUuid && !isDeploymentTarget && parsedUuid !== selectedProjectId) {
      setSelectedProjectId(parsedUuid);
    }

    const initReasoning = parsedCommand
      ? `Analyzing deployment context and files for \`${parsedCommand}\`...`
      : "Analyzing request and inspecting project workspace...";

    setStreamReasoning(initReasoning);
    setStreamContent("");
    setStreamToolCalls([]);
    setIsStreaming(true);

    const controller = new AbortController();
    streamAbortRef.current = controller;

    let reasoning = initReasoning + "\n";
    let content = "";
    let toolCalls: ToolCall[] = [];
    let stats: ChatMessage["stats"] = {};
    let messageAppended = false;

    const appendStoppedResponse = () => {
      if (messageAppended) return;
      if (!content.trim() && !reasoning.trim() && toolCalls.length === 0) return;
      messageAppended = true;

      // If content is empty (e.g. model was still generating thoughts or running subagents),
      // promote reasoning directly into content so the response NEVER disappears!
      let finalBody = content.trim();
      let finalReasoning: string | undefined = reasoning.trim() || undefined;

      if (!finalBody && reasoning.trim()) {
        finalBody = reasoning.trim();
        finalReasoning = undefined;
      }

      finalBody = finalBody ? `${finalBody}\n\n*(Generation stopped by user)*` : "*(Generation stopped by user)*";

      appendMessage({
        role: "assistant",
        content: finalBody,
        reasoning: finalReasoning,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        stats,
      });

      if (activeSessionId) {
        api.post(`/ai/sessions/${activeSessionId}/messages`, {
          role: "assistant",
          content: finalBody,
          metadata: {
            reasoning: finalReasoning,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            stopped: true,
          },
        }).catch(() => {});
      }
    };

    try {
      await streamAgentReply({
        message: prompt,
        command: parsedCommand || undefined,
        deploymentId: targetDeploymentId,
        projectId: targetProjectId,
        sessionId: activeSessionId || undefined,
        modelMode: mode === "thinking" ? "thinking" : "fast",
        model: activeModelId,
        provider,
        agentAccessMode,
        remoteTerminal: remoteTerminalPermission,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "start" && event.session_id) {
            if (event.session_id !== activeSessionId) {
              setActiveSessionId(event.session_id);
              if (typeof window !== "undefined") {
                window.history.replaceState(null, "", `/dashboard/ai?session_id=${event.session_id}`);
              }
              queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
            }
          } else if (event.type === "reasoning") {
            reasoning += event.delta;
            setStreamReasoning(reasoning);
          } else if (event.type === "tool_call") {
            const newCall: ToolCall = {
              name: event.name,
              arguments: event.arguments,
            };
            toolCalls = [...toolCalls, newCall];
            setStreamToolCalls([...toolCalls]);
          } else if (event.type === "tool_result") {
            let foundIdx = -1;
            for (let i = toolCalls.length - 1; i >= 0; i--) {
              if (toolCalls[i].name === event.name && (toolCalls[i].result === undefined || toolCalls[i].result === null)) {
                foundIdx = i;
                break;
              }
            }
            if (foundIdx === -1) {
              foundIdx = toolCalls.map((c) => c.name).lastIndexOf(event.name);
            }
            if (foundIdx !== -1) {
              toolCalls = [
                ...toolCalls.slice(0, foundIdx),
                { ...toolCalls[foundIdx], result: event.result },
                ...toolCalls.slice(foundIdx + 1),
              ];
            } else {
              toolCalls = [...toolCalls, { name: event.name, arguments: {}, result: event.result }];
            }
          } else if (event.type === "permission_request") {
            const toolName = event.tool_name || "Action";
            const args = event.arguments || {};
            const cmd = toolName === "terminal_run_command" ? (args.command as string) : undefined;
            setPendingApproval({
              id: `perm-${Date.now()}`,
              type: toolName === "terminal_run_command" ? "terminal" : "deploy",
              title: `Permission Needed: ${toolName}`,
              description: `Agent requested permission to execute high-risk action "${toolName}". Review parameters below.`,
              command: cmd,
              action: async () => {
                const approvalMsg = cmd
                  ? `Confirmed: Accept & run \`${cmd}\``
                  : `Confirmed: Approve execution of ${toolName}`;
                await sendStreaming(approvalMsg);
              },
              onDecline: () => {
                appendMessage({
                  role: "assistant",
                  content: `Execution of **${toolName}** was declined by user.`,
                  meta: "Action Declined",
                });
              },
            });
          } else if (event.type === "content") {
            content += event.delta;
            setStreamContent(content);
          } else if (event.type === "error") {
            content += `\n\n_${event.error}_`;
            setStreamContent(content);
          } else if (event.type === "done") {
            if (event.session_id && event.session_id !== activeSessionId) {
              setActiveSessionId(event.session_id);
              if (typeof window !== "undefined") {
                window.history.replaceState(null, "", `/dashboard/ai?session_id=${event.session_id}`);
              }
            }
            // The done frame carries the authoritative assembled text; trust it
            // over the accumulated deltas in case a frame was dropped.
            content = event.content || content;
            reasoning = event.reasoning || reasoning;
            const usage = event.token_usage || {};
            stats = {
              latencyMs: event.latency_ms,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
              model: event.model || activeModelId,
              provider: event.provider,
              traceId: event.trace_id,
            };
          }
        },
      });

      if (controller.signal.aborted) {
        appendStoppedResponse();
      } else {
        messageAppended = true;
        appendMessage({
          role: "assistant",
          content: content || (reasoning.trim() ? reasoning : "_The model returned nothing._"),
          reasoning: reasoning.trim() ? reasoning : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          stats,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        appendStoppedResponse();
      } else {
        appendMessage({
          role: "assistant",
          content: errorMessage(error, "Streaming failed."),
        });
      }
    } finally {
      if (controller.signal.aborted) {
        appendStoppedResponse();
      }
      setIsStreaming(false);
      setStreamReasoning("");
      setStreamContent("");
      setStreamToolCalls([]);
      streamAbortRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
      sessionsQuery.refetch();
    }
  };

  const isRunning = isStreaming || runAgentMutation.isPending || commandMutation.isPending || autonomousDeployMutation.isPending;

  // The verb is picked from what was actually asked, so the indicator keys off
  // the most recent user turn rather than the composer (which is cleared on
  // submit).
  const lastUserPrompt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return "";
  }, [messages]);

  const submit = () => {
    if (isListening) {
      stopListening();
    }
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    appendMessage({ role: "user", content: trimmed });
    setInput("");
    setShowCommands(false);

    const isAiCommand =
      /^\/(architect|swarm|plan|audit|review|code|repair|fix|diagnose|analyze|dockerfile|terminal|run|exec)\b/i.test(trimmed) ||
      (/^\/deploy\b/i.test(trimmed) && trimmed.replace(/^\/deploy\b/i, "").trim().length > 10);

    const isPlatformCommand = /^\/(cost|org|environments|build|app|help|events|metrics|rollback|pause|resume|scale|drift|secrets)\b/i.test(trimmed);

    if (isAiCommand || (!isPlatformCommand && trimmed.startsWith("/"))) {
      void sendStreaming(trimmed);
    } else if (trimmed.startsWith("/")) {
      commandMutation.mutate(trimmed);
    } else if (isDeployIntent(trimmed)) {
      autonomousDeployMutation.mutate(trimmed);
    } else if (streamingEnabled) {
      void sendStreaming(trimmed);
    } else {
      runAgentMutation.mutate(trimmed);
    }
  };

  const handleAllowToolCall = async (call: ToolCall) => {
    // 1. Clear pending approval banner if matching
    if (pendingApproval) {
      const action = pendingApproval.action;
      setPendingApproval(null);
      if (action) {
        await action();
        return;
      }
    }

    // 2. Interactive execution for terminal commands
    if (call.name === "terminal_run_command" && call.arguments?.command) {
      const cmd = call.arguments.command as string;
      toast.info(`Executing: ${cmd}`);
      try {
        const res = await api.post("/ai/tools/execute", {
          name: "terminal_run_command",
          arguments: {
            command: cmd,
            deployment_id: selectedDeploymentId || undefined,
            project_id: selectedProjectId || undefined,
          },
        });
        const toolResult = res.data?.result || res.data;
        // Update live stream tool calls
        setStreamToolCalls((current) =>
          current.map((tc) =>
            tc === call || (tc.name === call.name && tc.arguments?.command === cmd)
              ? { ...tc, result: toolResult }
              : tc
          )
        );
        // Also update any message in history containing this tool call
        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.toolCalls) return msg;
            return {
              ...msg,
              toolCalls: msg.toolCalls.map((tc) =>
                tc === call || (tc.name === call.name && tc.arguments?.command === cmd)
                  ? { ...tc, result: toolResult }
                  : tc
              ),
            };
          })
        );
        await sendStreaming(
          `Confirmed: Accept & run \`${cmd}\`\nOutput:\n\`\`\`\n${
            toolResult?.stdout || toolResult?.output || toolResult?.stderr || "Done"
          }\n\`\`\``
        );
      } catch (err) {
        toast.error("Failed to execute command");
      }
      return;
    }

    // 3. For any other mutating action
    const toolTitle = call.name;
    toast.success(`Approved ${toolTitle}`);
    await sendStreaming(
      `Confirmed: Approve execution of ${toolTitle} with arguments: ${JSON.stringify(call.arguments)}`
    );
  };

  const handleDenyToolCall = (call: ToolCall) => {
    if (pendingApproval) {
      pendingApproval.onDecline?.();
      setPendingApproval(null);
    }
    const declinedResult = { status: "declined", error: "User declined execution of this tool." };
    setStreamToolCalls((current) =>
      current.map((tc) =>
        tc === call || (tc.name === call.name && JSON.stringify(tc.arguments) === JSON.stringify(call.arguments))
          ? { ...tc, result: declinedResult }
          : tc
      )
    );
    setMessages((prev) =>
      prev.map((msg) => {
        if (!msg.toolCalls) return msg;
        return {
          ...msg,
          toolCalls: msg.toolCalls.map((tc) =>
            tc === call || (tc.name === call.name && JSON.stringify(tc.arguments) === JSON.stringify(call.arguments))
              ? { ...tc, result: declinedResult }
              : tc
          ),
        };
      })
    );
    appendMessage({
      role: "assistant",
      content: `Execution of **${call.name}** was declined by user.`,
      meta: "Action Declined",
    });
    toast.info(`Declined ${call.name}`);
  };

  const handleCopy = (id: string, text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedId(id);
      toast.success("Copied to clipboard");
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 2000);
    }
  };

  const handleBranchChat = async (messageIndex: number) => {
    const branchMessages = messages.slice(0, messageIndex + 1);
    if (activeSessionId) {
      try {
        const res = await api.post(`/ai/sessions/${activeSessionId}/branch`, {
          message_index: messageIndex,
        });
        if (res.data?.id) {
          setActiveSessionId(res.data.id);
          setMessages(branchMessages);
          if (typeof window !== "undefined") {
            window.history.replaceState(null, "", `/dashboard/ai?session_id=${res.data.id}`);
          }
          queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
          toast.success("Branched into new chat session");
          return;
        }
      } catch (err) {
        console.error("Failed to branch server session:", err);
      }
    }
    setMessages(branchMessages);
    toast.success("Branched into new conversation");
  };

  const handleRegenerate = async (assistantIndex: number) => {
    if (isRunning) return;
    let userPrompt = "";
    let userIndex = -1;
    for (let i = assistantIndex - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        userPrompt = messages[i].content;
        userIndex = i;
        break;
      }
    }
    if (!userPrompt || userIndex === -1) return;

    setMessages(messages.slice(0, userIndex + 1));
    const isAiCommand =
      /^\/(architect|swarm|plan|audit|review|code|repair|fix|diagnose|analyze|dockerfile|terminal|run|exec)\b/i.test(userPrompt) ||
      (/^\/deploy\b/i.test(userPrompt) && userPrompt.replace(/^\/deploy\b/i, "").trim().length > 10);

    const isPlatformCommand = /^\/(cost|org|environments|build|app|help|events|metrics|rollback|pause|resume|scale|drift|secrets)\b/i.test(userPrompt);

    if (isAiCommand || (!isPlatformCommand && userPrompt.startsWith("/"))) {
      void sendStreaming(userPrompt);
    } else if (userPrompt.startsWith("/")) {
      commandMutation.mutate(userPrompt);
    } else if (isDeployIntent(userPrompt)) {
      autonomousDeployMutation.mutate(userPrompt);
    } else if (streamingEnabled) {
      void sendStreaming(userPrompt);
    } else {
      runAgentMutation.mutate(userPrompt);
    }
  };

  const filteredCommands = useMemo(() => {
    if (!input.startsWith("/")) return commands;
    const token = input.split(/\s+/)[0].toLowerCase();
    return commands.filter((command) => command.name.startsWith(token));
  }, [input]);

  const chooseDeploymentForCommand = (deployment: Deployment) => {
    setSelectedDeploymentId(deployment.id);
    setSelectedProjectId(deployment.project_id);
    // Keep whichever command is pending rather than hardcoding one.
    setInput(`${pendingCommand?.name || "/diagnose"} ${deployment.id} `);
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const chooseProjectForCommand = (project: Project) => {
    setSelectedProjectId(project.id);
    setInput(`${pendingCommand?.name || "/analyze"} ${project.id} `);
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const chooseAppForCommand = (template: string) => {
    setInput(`/app ${template} `);
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const commandDraft = (name: (typeof commands)[number]["name"]) => {
    if (name === "/diagnose") return selectedDeploymentId ? `/diagnose ${selectedDeploymentId}` : "/diagnose ";
    if (name === "/build") return selectedDeploymentId ? `/build ${selectedDeploymentId}` : "/build ";
    if (name === "/deploy") return selectedDeploymentId ? `/deploy ${selectedDeploymentId} ` : "/deploy ";
    if (name === "/dockerfile") return selectedProjectId ? `/dockerfile ${selectedProjectId}` : "/dockerfile ";
    if (name === "/analyze") return selectedProjectId ? `/analyze ${selectedProjectId}` : "/analyze ";
    return `${name} `;
  };

  const chooseCommand = (name: (typeof commands)[number]["name"]) => {
    setInput(commandDraft(name));
    setShowCommands(false);
    setCommandPickerOpen(false);
  };

  const renderModelButtons = (items: AiModel[], onAfterSelect?: () => void) =>
    items.length === 0 ? (
      <div className="px-2 py-2 text-sm text-muted-foreground">No models available</div>
    ) : (
      items.map((model) => (
        <button
          key={model.id}
          type="button"
          onClick={() => {
            chooseModel(model);
            onAfterSelect?.();
          }}
          className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground"
        >
          <span className="min-w-0 truncate">{modelLabel(model)}</span>
          {model.id === activeModelId && <AppIcon name="check" fallback={Check} className="h-4 w-4"  />}
        </button>
      ))
    );

  const renderModelPicker = (onAfterSelect?: () => void) => (
    <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
      {availableModels.length === 0 ? (
        <div className="p-3 text-center text-xs text-muted-foreground">
          No models found. Enter an API key and click &ldquo;Fetch Models&rdquo; in settings, or type any custom model ID.
        </div>
      ) : (
        <>
          {fastModels.length > 0 && (
            <>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Fast models ({fastModels.length})</div>
              {renderModelButtons(fastModels, onAfterSelect)}
            </>
          )}
          {thinkingModels.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Thinking models ({thinkingModels.length})</div>
              {renderModelButtons(thinkingModels, onAfterSelect)}
            </>
          )}
        </>
      )}
    </div>
  );

  const renderCommandPicker = () => (
    <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Agent commands</div>
      {commands.map((command) => (
        <button
          key={command.name}
          type="button"
          onClick={() => chooseCommand(command.name)}
          className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-accent hover:text-accent-foreground"
        >
          {command.icon === Terminal ? (
            <Terminal className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : (
            <FilledStarIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{command.usage}</span>
            <span className="block text-xs text-muted-foreground">{command.description}</span>
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="flex h-full min-h-0 overflow-hidden bg-background text-foreground">
        <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-border/40 px-6 py-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={startNewChat}
            >
              <AppIcon name="plus" fallback={Plus} className="h-3.5 w-3.5" />
              New Chat
            </Button>
            {activeSession?.title && (
              <span className="hidden max-w-xs truncate text-xs text-muted-foreground sm:inline-block">
                {activeSession.title}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant={terminalOpen ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "h-8 gap-1.5 px-3 text-xs transition-colors",
                terminalOpen ? "text-foreground font-medium bg-muted" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTerminalOpen((open) => !open)}
              title="Toggle Workspace Terminal"
            >
              <AppIcon name="terminal" fallback={Terminal} className="h-4 w-4 mr-1.5" />
              Terminal
              {terminalOpen && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
            </Button>
            <Link href="/dashboard/ai/history">
              <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground">
                <AppIcon name="clock" fallback={Clock} className="h-3.5 w-3.5" />
                History
              </Button>
            </Link>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label="Agent settings"
              onClick={() => setSettingsOpen(true)}
            >
              <AppIcon name="settings" fallback={Settings} className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:px-8">
          <div className="mx-auto flex max-w-5xl flex-col gap-6">
            {messages.map((message, messageIndex) => (
              <div
                key={message.id}
                className={cn("flex gap-3", message.role === "user" ? "justify-end" : "justify-start")}
              >
                {message.role !== "user" && (
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                    <AppIcon name="star" fallback={Star} className="h-4 w-4"  />
                  </div>
                )}
                <div
                  className={cn(
                    "min-w-0 max-w-[min(56rem,88%)] rounded-2xl px-5 py-4 overflow-hidden break-words",
                    message.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-background"
                  )}
                >
                  {(() => {
                    const parsed = message.role === "assistant"
                      ? parseAssistantMessageContent(message.content, message.reasoning)
                      : { content: message.content, reasoningBlocks: [] };

                    return (
                      <>
                        {message.role === "assistant" && (
                          <ThinkingPanel
                            reasoning={parsed.reasoningBlocks.length > 0 ? parsed.reasoningBlocks : undefined}
                            stats={message.stats}
                            orbStyle={orbStyle}
                          />
                        )}
                        {message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0 && (
                          <ToolsPanel
                            toolCalls={message.toolCalls}
                            onOpenTerminal={openTerminalWithCommand}
                            onAllow={handleAllowToolCall}
                            onDeny={handleDenyToolCall}
                          />
                        )}
                        {message.role === "user" ? (
                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
                        ) : (
                          <div className="prose-ai min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-sm leading-relaxed">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {parsed.content}
                            </ReactMarkdown>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {message.role === "assistant" && (
                    <div className="mt-2.5 flex items-center gap-0.5 text-muted-foreground">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={copiedId === message.id ? "Copied" : "Copy"}
                        aria-label="Copy message"
                        onClick={() => handleCopy(message.id, message.content)}
                      >
                        {copiedId === message.id ? (
                          <AppIcon name="check" fallback={Check} className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <AppIcon name="copy" fallback={Copy} className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Branch into new chat"
                        aria-label="Branch into new chat"
                        onClick={() => handleBranchChat(messageIndex)}
                      >
                        <AppIcon name="git-fork" fallback={GitFork} className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={isRunning}
                        className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Regenerate response"
                        aria-label="Regenerate response"
                        onClick={() => handleRegenerate(messageIndex)}
                      >
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isStreaming && (
              <div className="flex justify-start">
                <div className="min-w-0 max-w-[min(56rem,88%)] rounded-2xl border border-border bg-background px-5 py-4 overflow-hidden break-words">
                  {(() => {
                    const parsedStream = parseAssistantMessageContent(streamContent, streamReasoning);
                    return (
                      <>
                        {(parsedStream.reasoningBlocks.length > 0 || isStreaming) && (
                          <ThinkingPanel
                            isGenerating={isStreaming}
                            reasoning={
                              parsedStream.reasoningBlocks.length > 0
                                ? parsedStream.reasoningBlocks
                                : "Initializing workspace context and analyzing request..."
                            }
                            orbStyle={orbStyle}
                          />
                        )}
                        {streamToolCalls.length > 0 && (
                          <ToolsPanel
                            toolCalls={streamToolCalls}
                            isGenerating={isStreaming}
                            onOpenTerminal={openTerminalWithCommand}
                            onAllow={handleAllowToolCall}
                            onDeny={handleDenyToolCall}
                          />
                        )}
                        {parsedStream.content && (
                          <div className="prose-ai min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-sm leading-relaxed">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {parsedStream.content}
                            </ReactMarkdown>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <button
                    type="button"
                    onClick={() => streamAbortRef.current?.abort()}
                    className="mt-3 inline-flex items-center gap-1.5 text-xs text-rose-500 hover:text-rose-600 font-medium px-2 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 transition-colors cursor-pointer"
                  >
                    <Square className="h-3 w-3 fill-current" />
                    <span>Stop generation</span>
                  </button>
                </div>
              </div>
            )}
            {pendingApproval && (
              <div className="my-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-start gap-3.5">
                  <div className="rounded-xl bg-amber-500/20 p-2.5 text-amber-500 shrink-0">
                    <ShieldAlert className="h-5 w-5" />
                  </div>
                  <div className="flex-1 space-y-2 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <h4 className="font-semibold text-foreground text-sm">{pendingApproval.title}</h4>
                      <Badge variant="outline" className="border-amber-500/40 text-amber-500 text-[10px] uppercase tracking-wider font-mono">
                        Permission Required
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed break-words">
                      {pendingApproval.description}
                    </p>
                    {pendingApproval.command && (
                      <pre className="rounded-lg bg-zinc-950/80 p-2.5 font-mono text-xs text-emerald-400 overflow-x-auto border border-zinc-800">
                        <span className="text-zinc-500 select-none">$ </span>{pendingApproval.command}
                      </pre>
                    )}
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs h-8 px-3.5 gap-1.5 shadow-sm"
                        onClick={async () => {
                          const act = pendingApproval.action;
                          setPendingApproval(null);
                          await act();
                        }}
                      >
                        <Check className="h-3.5 w-3.5" />
                        Accept & Run
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-border hover:bg-rose-500/10 hover:text-rose-500 font-medium text-xs h-8 px-3.5 gap-1.5"
                        onClick={() => {
                          const dec = pendingApproval.onDecline;
                          setPendingApproval(null);
                          dec();
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                        Decline
                      </Button>
                      {pendingApproval.command && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="font-medium text-xs h-8 px-3 gap-1.5"
                          onClick={() => {
                            openTerminalWithCommand(pendingApproval.command);
                          }}
                        >
                          <Terminal className="h-3.5 w-3.5 text-emerald-500" />
                          Inspect in Terminal
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {isRunning && !isStreaming && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                {orbStyle !== "off" && (
                  <ThinkingOrb
                    state={orbStyle}
                    size={20}
                    theme={isDark ? "dark" : "light"}
                  />
                )}
                <StatusVerb prompt={lastUserPrompt} />
              </div>
            )}
          </div>
        </div>

        {/* Interactive Workspace Terminal Drawer */}
        {terminalOpen && (
          <div
            className={cn(
              "shrink-0 border-t border-border/80 bg-zinc-950 text-zinc-200 shadow-xl flex flex-col transition-all duration-150 z-10",
              terminalExpanded ? "h-80" : "h-56"
            )}
          >
            {/* Terminal Drawer Header */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800/80 bg-zinc-900/80 select-none text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <Terminal className="h-3.5 w-3.5 text-zinc-400" />
                <span className="font-mono text-xs font-medium text-zinc-200">Terminal</span>
                <span className="text-zinc-600">·</span>
                <span className="text-[11px] font-mono text-zinc-400 truncate max-w-[16rem]">
                  {terminalCwd || (selectedDeployment ? `uploads/builds/${selectedDeployment.id.slice(0, 8)}/source` : selectedProject ? `uploads/projects/${selectedProject.id.slice(0, 8)}/source` : "workspace")}
                </span>
              </div>

              {/* Header actions & quick chips */}
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="hidden sm:flex items-center gap-1 mr-1">
                  {[
                    { label: "dir", cmd: "dir" },
                    { label: "node -v", cmd: "node -v" },
                    { label: "git status", cmd: "git status" },
                  ].map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      disabled={isTerminalExecuting}
                      onClick={() => runTerminalCommand(action.cmd)}
                      className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-zinc-800/70 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors shrink-0 disabled:opacity-50"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  onClick={() => setTerminalLogs([])}
                  title="Clear Output"
                >
                  <AppIcon name="trash" fallback={Trash2} className="h-3 w-3" />
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  onClick={() => setTerminalExpanded((prev) => !prev)}
                  title={terminalExpanded ? "Collapse" : "Expand"}
                >
                  {terminalExpanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-zinc-400 hover:text-rose-400 hover:bg-zinc-800"
                  onClick={() => setTerminalOpen(false)}
                  title="Close Terminal"
                >
                  <AppIcon name="x" fallback={X} className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {/* Terminal Console Output */}
            <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-2.5 select-text min-h-0">
              {terminalLogs.length === 0 ? (
                <div className="text-zinc-600 font-mono text-xs py-1 select-none">
                  Terminal ready. Run commands in workspace.
                </div>
              ) : (
                terminalLogs.map((log) => (
                  <div key={log.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 border-b border-zinc-800/40 pb-0.5">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <span className="text-zinc-600 select-none text-[10px]">[{log.timestamp}]</span>
                        <div className="flex items-center gap-1 text-zinc-300 font-medium truncate">
                          <span className="text-zinc-600 select-none">$</span>
                          <span className="truncate">{log.command}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {log.status === "running" ? (
                          <span className="text-[10px] text-zinc-400 flex items-center gap-1">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            <span>running</span>
                          </span>
                        ) : log.exitCode === 0 ? (
                          <Badge variant="outline" className="h-4 px-1 text-[9px] font-mono border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                            exit 0
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="h-4 px-1 text-[9px] font-mono border-rose-500/30 text-rose-400 bg-rose-500/10">
                            exit {log.exitCode ?? 1}
                          </Badge>
                        )}
                      </div>
                    </div>

                    {log.status === "running" && (
                      <div className="text-zinc-500 italic text-[11px] flex items-center gap-1.5 py-0.5">
                        <Loader2 className="h-2.5 w-2.5 animate-spin text-zinc-400" />
                        <span>Executing...</span>
                      </div>
                    )}

                    {log.stdout && (
                      <pre className="whitespace-pre-wrap break-words text-zinc-300 leading-relaxed overflow-x-auto text-[11px]">
                        {log.stdout}
                      </pre>
                    )}

                    {log.stderr && (
                      <pre className="whitespace-pre-wrap break-words text-rose-400 leading-relaxed overflow-x-auto text-[11px]">
                        {log.stderr}
                      </pre>
                    )}

                    {log.status !== "running" && !log.stdout && !log.stderr && (
                      <div className="text-zinc-600 italic text-[10px]">(command finished with no output)</div>
                    )}
                  </div>
                ))
              )}
              <div ref={terminalLogsEndRef} />
            </div>

            {/* Interactive Command Input Line */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                runTerminalCommand(terminalInput);
              }}
              className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/80 border-t border-zinc-800 shrink-0 font-mono text-xs"
            >
              <span className="text-zinc-500 font-bold select-none text-xs">$</span>
              <input
                ref={terminalInputRef}
                type="text"
                value={terminalInput}
                disabled={isTerminalExecuting}
                onChange={(e) => setTerminalInput(e.target.value)}
                onKeyDown={handleTerminalKeyDown}
                placeholder="Run a command..."
                className="flex-1 bg-transparent border-none outline-none text-zinc-200 placeholder:text-zinc-600 font-mono text-xs disabled:opacity-50"
              />
              {isTerminalExecuting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
              ) : (
                <button
                  type="submit"
                  disabled={!terminalInput.trim()}
                  className="text-zinc-500 hover:text-zinc-300 disabled:opacity-30 transition-colors p-0.5 cursor-pointer"
                  title="Run (Enter)"
                >
                  <CornerDownLeft className="h-3.5 w-3.5" />
                </button>
              )}
            </form>
          </div>
        )}

        <div className="sticky bottom-0 z-20 shrink-0 border-t border-border bg-background/95 px-4 pb-4 pt-3 backdrop-blur md:px-6">
          <div ref={composerRef} className="mx-auto max-w-5xl">
            {argPickerOpen && pendingCommand?.arg === "deployment" && (
              <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Pick a deployment for {pendingCommand.name}
                </div>
                {pickableDeployments.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground">No deployments yet.</div>
                ) : (
                  pickableDeployments.map((deployment) => (
                    <button
                      key={deployment.id}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted"
                      onClick={() => chooseDeploymentForCommand(deployment)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{deployment.project_name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {deployment.version || "unversioned"} · {shortId(deployment.id)}
                        </span>
                      </span>
                      <Badge variant={deployment.status === "failed" ? "destructive" : "outline"}>
                        {deployment.status}
                      </Badge>
                    </button>
                  ))
                )}
              </div>
            )}

            {argPickerOpen && pendingCommand?.arg === "project" && (
              <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Pick a project for {pendingCommand.name}
                </div>
                {projects.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground">No projects yet.</div>
                ) : (
                  projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted"
                      onClick={() => chooseProjectForCommand(project)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{project.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {project.source_type || "project"} · {shortId(project.id)}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {argPickerOpen && pendingCommand?.arg === "app" && (
              <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Pick an application to deploy
                </div>
                {/* Straight from the list /app actually accepts, so the
                    picker cannot drift from the handler. */}
                {agentApplicationTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted"
                    onClick={() => chooseAppForCommand(template.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{template.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        /app {template.id}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {showCommands && !argPickerOpen && filteredCommands.length > 0 && (
              // Capped and scrollable. Unbounded, twenty commands covered the
              // entire conversation behind it.
              <div className="mb-2 max-h-64 overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-popover shadow-xl">
                {filteredCommands.map((command) => (
                  <button
                    key={command.name}
                    type="button"
                    className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-muted"
                    onClick={() => {
                      // Trailing space is the signal that an argument is
                      // expected, which is what opens the next picker.
                      setInput(`${command.name} `);
                      setShowCommands(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    {command.icon === Terminal ? (
                      <Terminal className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : (
                      <FilledStarIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{command.usage}</span>
                      <span className="block text-xs text-muted-foreground">{command.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="rounded-2xl border border-border bg-background px-3 py-2 shadow-sm">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  // Only while the command name itself is being typed. Once a
                  // space is entered the user has moved on to the argument,
                  // and the palette reappearing over the picker is noise.
                  setShowCommands(/^\/[a-z-]*$/i.test(event.target.value));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Ask the agent, or type / for commands..."
                rows={1}
                className="max-h-44 min-h-10 w-full resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="relative">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="max-w-[18rem] justify-start"
                      suppressHydrationWarning
                      onClick={() => {
                        setComposerModelOpen((open) => !open);
                        setSettingsModelOpen(false);
                        setProjectOpen(false);
                        setDeploymentOpen(false);
                      }}
                    >
                      {mode === "thinking" ? <AppIcon name="brain-circuit" fallback={BrainCircuit} className="h-4 w-4"  /> : <AppIcon name="zap" fallback={Zap} className="h-4 w-4"  />}
                      <span className="truncate" suppressHydrationWarning>
                        {mode === "thinking" ? "Think" : "Fast"} | {shortId(modelLabel(activeModel), 18)}
                      </span>
                      <AppIcon name="chevron-down" fallback={ChevronDown} className="ml-1 h-3.5 w-3.5"  />
                    </Button>
                    {composerModelOpen && (
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-80">
                        {renderModelPicker(closePickers)}
                      </div>
                    )}
                  </div>

                  <div className="relative">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setCommandPickerOpen((open) => !open);
                        setComposerModelOpen(false);
                        setSettingsModelOpen(false);
                        setProjectOpen(false);
                        setDeploymentOpen(false);
                      }}
                    >
                      <FilledStarIcon className="size-4 shrink-0" />
                      Commands
                      <AppIcon name="chevron-down" fallback={ChevronDown} className="ml-1 h-3.5 w-3.5"  />
                    </Button>
                    {commandPickerOpen && (
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-96 max-w-[calc(100vw-3rem)]">
                        {renderCommandPicker()}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant={isListening ? "destructive" : "outline"}
                    size={isListening ? "default" : "icon"}
                    onClick={toggleListening}
                    disabled={isRunning}
                    className={cn(
                      "h-9 shrink-0 transition-all",
                      isListening
                        ? "gap-2 px-3 bg-red-500 hover:bg-red-600 text-white shadow-md animate-pulse border-red-500"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    title={isListening ? "Listening... Click to finish voice input" : "Voice input (Speech to text)"}
                    aria-label={isListening ? "Stop voice input" : "Start voice input"}
                  >
                    {isListening ? (
                      <>
                        <ThinkingOrb state="listening" size={20} theme="dark" />
                        <span className="text-xs font-medium">Listening...</span>
                        <AppIcon name="square" fallback={Square} className="h-3 w-3 fill-current ml-0.5" />
                      </>
                    ) : (
                      <AppIcon name="mic" fallback={Mic} className="h-4 w-4" />
                    )}
                  </Button>

                  {isStreaming ? (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => streamAbortRef.current?.abort()}
                      className="gap-1.5 shadow-sm bg-red-600 hover:bg-red-700 text-white font-medium active:scale-95 transition-all"
                      title="Stop generating response"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                      Stop
                    </Button>
                  ) : (
                    <Button type="button" onClick={submit} disabled={!input.trim() || isRunning}>
                      {isRunning ? (
                        <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin" />
                      ) : (
                        <AppIcon name="send" fallback={Send} className="h-4 w-4" />
                      )}
                      Send
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        </section>
      </div>

      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) closePickers();
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl max-w-[95vw] p-6">
          <DialogHeader>
            <DialogTitle>Agent Settings</DialogTitle>
            <DialogDescription>Configure provider keys, model, reasoning mode, project context, and deployment context.</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
            <div className="space-y-6">
            {/* ── 1. How it answers ─────────────────────────────── */}
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">How it answers</h3>
                <p className="text-xs text-muted-foreground">
                  Applies immediately. No need to save.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Reasoning mode</Label>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/30 p-1">
                  <Button
                    type="button"
                    variant={mode === "fast" ? "default" : "ghost"}
                    onClick={() => {
                      setMode("fast");
                      setSelectedModel(fastModels[0]?.id || "");
                    }}
                  >
                    <AppIcon name="zap" fallback={Zap} className="h-4 w-4"  />
                    Fast
                  </Button>
                  <Button
                    type="button"
                    variant={mode === "thinking" ? "default" : "ghost"}
                    onClick={() => {
                      setMode("thinking");
                      setSelectedModel(thinkingModels[0]?.id || "");
                    }}
                  >
                    <AppIcon name="brain-circuit" fallback={BrainCircuit} className="h-4 w-4"  />
                    Thinking
                  </Button>
                </div>
                {/* Sits under the control it describes, rather than at the
                    bottom of the dialog where it read as a general footnote. */}
                <p className="text-xs text-muted-foreground">
                  {mode === "fast"
                    ? "Quick replies for chat and simple commands. Switching modes also picks a matching model."
                    : "Slower and more careful. Use for diagnosing failures, planning Dockerfiles, and deployment decisions."}
                </p>
              </div>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/20 p-3">
                <div className="min-w-0">
                  <Label className="cursor-pointer" htmlFor="stream-toggle">
                    Stream the reply
                  </Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Show reasoning and text as the model produces them. Turn off to wait for
                    one complete reply instead.
                  </p>
                </div>
                <button
                  id="stream-toggle"
                  type="button"
                  role="switch"
                  aria-checked={streamingEnabled}
                  onClick={() => setStreamingEnabled((value) => !value)}
                  className={cn(
                    "mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                    streamingEnabled ? "bg-primary" : "bg-muted-foreground/30"
                  )}
                >
                  <span
                    className={cn(
                      "inline-block h-4 w-4 rounded-full bg-background transition-transform",
                      streamingEnabled ? "translate-x-4" : "translate-x-0.5"
                    )}
                  />
                </button>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Model</Label>
                  <span className="text-xs text-muted-foreground">
                    {availableModels.length > 0 ? `${availableModels.length} models available` : "Enter any model"}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={selectedModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                    placeholder={activeModelId || "Type or choose any model ID"}
                    className="font-mono text-xs"
                  />
                  <div className="relative">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSettingsModelOpen((open) => !open);
                        setProjectOpen(false);
                        setDeploymentOpen(false);
                        setComposerModelOpen(false);
                      }}
                      title="Select from fetched models"
                    >
                      <AppIcon name="chevron-down" fallback={ChevronDown} className="h-4 w-4" />
                    </Button>
                    {settingsModelOpen && (
                      <div className="absolute right-0 top-full z-50 mt-2 w-80">
                        {renderModelPicker(closePickers)}
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pick from the dynamic provider list or type any custom model ID directly.
                </p>
              </div>

              {/* ── Thinking Orb Effect ───────────────────────────── */}
              <div className="space-y-2 border-t border-border/70 pt-3">
                <div className="flex items-center justify-between">
                  <Label>Thinking Orb Effect</Label>
                  <span className="text-xs font-mono text-muted-foreground">
                    {orbStyle === "off" ? "Off" : orbStyle}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Select which animated orb to show during thinking & streaming, or disable it completely.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 rounded-lg border border-border bg-muted/20 p-2">
                  {ORB_STYLES.map((style) => {
                    const isSelected = orbStyle === style.id;
                    return (
                      <button
                        key={style.id}
                        type="button"
                        onClick={() => setOrbStyle(style.id)}
                        className={cn(
                          "flex flex-col items-center justify-center rounded-md p-2 text-xs transition-all border",
                          isSelected
                            ? "bg-primary text-primary-foreground shadow-sm border-primary font-semibold"
                            : "border-transparent hover:bg-muted text-muted-foreground hover:text-foreground"
                        )}
                        title={style.description}
                      >
                        <div className="h-6 w-6 flex items-center justify-center mb-1">
                          {style.id === "off" ? (
                            <span className="text-xs font-bold opacity-75">✕</span>
                          ) : (
                            <ThinkingOrb
                              state={style.id}
                              size={20}
                              theme={isSelected ? (isDark ? "dark" : "light") : "auto"}
                            />
                          )}
                        </div>
                        <span className="truncate max-w-[4.2rem] text-[11px] leading-tight">
                          {style.label.split(" ")[0]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Live Preview Card */}
                <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 p-2.5">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-background border border-border">
                    {orbStyle === "off" ? (
                      <span className="text-xs font-bold text-muted-foreground">OFF</span>
                    ) : (
                      <ThinkingOrb state={orbStyle} size={20} theme={isDark ? "dark" : "light"} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <span>{ORB_STYLES.find((s) => s.id === orbStyle)?.label || "Solving"}</span>
                      {orbStyle === "off" ? (
                        <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground font-normal">Disabled</span>
                      ) : (
                        <span className="text-[10px] rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 font-normal">Active</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">
                      {ORB_STYLES.find((s) => s.id === orbStyle)?.description || ""}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* ── 3. What it can see ────────────────────────────── */}
            <section className="space-y-3 border-t border-border pt-4">
              <div>
                <h3 className="text-sm font-medium">What it can see</h3>
                <p className="text-xs text-muted-foreground">
                  Scopes the agent to one project or deployment so it stops guessing which you mean.
                  Applies immediately.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Project</Label>
                  <div className="relative">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-between"
                      onClick={() => {
                        setProjectOpen((open) => !open);
                        setSettingsModelOpen(false);
                        setDeploymentOpen(false);
                        setComposerModelOpen(false);
                      }}
                    >
                      <span className="truncate">{selectedProject?.name || "Any project"}</span>
                      <AppIcon name="chevron-down" fallback={ChevronDown} className="h-4 w-4"  />
                    </Button>
                    {projectOpen && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedProjectId("");
                            setProjectOpen(false);
                          }}
                          className="flex min-h-9 w-full items-center rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                        >
                          Any project
                          {!selectedProjectId && <AppIcon name="check" fallback={Check} className="ml-auto h-4 w-4"  />}
                        </button>
                        <div className="my-1 h-px bg-border" />
                        {projects.map((project) => (
                          <button
                            key={project.id}
                            type="button"
                            onClick={() => {
                              setSelectedProjectId(project.id);
                              setProjectOpen(false);
                            }}
                            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          >
                            <span className="min-w-0 truncate">{project.name}</span>
                            {project.id === selectedProjectId && <AppIcon name="check" fallback={Check} className="ml-auto h-4 w-4"  />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Deployment</Label>
                  <div className="relative">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-between"
                      onClick={() => {
                        setDeploymentOpen((open) => !open);
                        setSettingsModelOpen(false);
                        setProjectOpen(false);
                        setComposerModelOpen(false);
                      }}
                    >
                      <span className="truncate">
                        {selectedDeployment
                          ? `${selectedDeployment.project_name} · ${selectedDeployment.status}`
                          : "Any deployment"}
                      </span>
                      <AppIcon name="chevron-down" fallback={ChevronDown} className="h-4 w-4"  />
                    </Button>
                    {deploymentOpen && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDeploymentId("");
                            setDeploymentOpen(false);
                          }}
                          className="flex min-h-9 w-full items-center rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                        >
                          Any deployment
                          {!selectedDeploymentId && <AppIcon name="check" fallback={Check} className="ml-auto h-4 w-4"  />}
                        </button>
                        <div className="my-1 h-px bg-border" />
                        {deployments.map((deployment) => (
                          <button
                            key={deployment.id}
                            type="button"
                            onClick={() => {
                              setSelectedDeploymentId(deployment.id);
                              setDeploymentOpen(false);
                            }}
                            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          >
                            <span className="min-w-0 truncate">
                              {deployment.project_name} · {deployment.status} · {shortId(deployment.id)}
                            </span>
                            {deployment.id === selectedDeploymentId && <AppIcon name="check" fallback={Check} className="ml-auto h-4 w-4"  />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
            </div>

            {/* Right Column: Where it runs & Permissions */}
            <div className="space-y-6">
            {/* ── 2. Where it runs ──────────────────────────────── */}
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">Where it runs</h3>
                <p className="text-xs text-muted-foreground">
                  Which service answers, and the key used to reach it. Changes here need saving.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Provider</Label>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/30 p-1">
                  <Button
                    type="button"
                    variant={provider === "nvidia_nim" ? "default" : "ghost"}
                    onClick={() => setProvider("nvidia_nim")}
                  >
                    NVIDIA
                  </Button>
                  <Button
                    type="button"
                    variant={provider === "openai_compatible" ? "default" : "ghost"}
                    onClick={() => setProvider("openai_compatible")}
                  >
                    OpenAI-compatible
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                {provider === "nvidia_nim" ? (
                  settingsQuery.data?.has_nvidia_key ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600 dark:text-emerald-400">
                      <AppIcon name="check" fallback={Check} className="h-3 w-3" />
                      NVIDIA key saved
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
                      No NVIDIA key saved yet
                    </span>
                  )
                ) : settingsQuery.data?.has_openai_compatible_key ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600 dark:text-emerald-400">
                    <AppIcon name="check" fallback={Check} className="h-3 w-3" />
                    API key saved
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
                    No API key saved yet
                  </span>
                )}
                {availableModels.length > 0 && (
                  <span className="text-muted-foreground">{availableModels.length} models fetched</span>
                )}
              </div>

              {provider === "nvidia_nim" && (
                <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-3">
                  <div className="space-y-2">
                    <Label>NVIDIA NIM API Key</Label>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={nvidiaApiKey}
                        onChange={(event) => setNvidiaApiKey(event.target.value)}
                        placeholder={
                          settingsQuery.data?.has_nvidia_key
                            ? "Leave blank to keep saved key"
                            : "Paste your nvapi-... key"
                        }
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={fetchModelsWithCurrentKey}
                        disabled={isFetchingModels}
                        title="Fetch models with this API key"
                      >
                        {isFetchingModels ? (
                          <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        <span className="ml-1.5 hidden sm:inline">Fetch Models</span>
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Enter your API key and click Fetch Models to dynamically load all available models from NVIDIA NIM.
                    </p>
                  </div>
                </div>
              )}

              {provider === "openai_compatible" && (
                <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Base URL</Label>
                    <Input
                      value={compatibleBaseUrl}
                      onChange={(event) => setCompatibleBaseUrl(event.target.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                    <p className="text-xs text-muted-foreground">
                      Must be HTTPS (OpenAI, OpenRouter, Groq, local proxy, etc.).
                    </p>
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>API Key</Label>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={compatibleApiKey}
                        onChange={(event) => setCompatibleApiKey(event.target.value)}
                        placeholder={
                          settingsQuery.data?.has_openai_compatible_key
                            ? "Leave blank to keep saved key"
                            : "Paste API key"
                        }
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={fetchModelsWithCurrentKey}
                        disabled={isFetchingModels}
                        title="Fetch models with this API key"
                      >
                        {isFetchingModels ? (
                          <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        <span className="ml-1.5 hidden sm:inline">Fetch Models</span>
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                {saveSettingsMutation.isSuccess && !saveSettingsMutation.isPending && (
                  <span className="text-xs text-muted-foreground">Saved</span>
                )}
                <Button
                  type="button"
                  onClick={() => saveSettingsMutation.mutate()}
                  disabled={saveSettingsMutation.isPending}
                >
                  {saveSettingsMutation.isPending ? (
                    <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  />
                  ) : (
                    <AppIcon name="check" fallback={Check} className="h-4 w-4"  />
                  )}
                  Save provider
                </Button>
              </div>
              {saveSettingsMutation.isError && (
                <p className="text-xs text-destructive">
                  {errorMessage(saveSettingsMutation.error, "Could not save provider settings.")}
                </p>
              )}
            </section>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <div>
                <Label>Agent Permissions</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  These permissions are persisted locally, sent with agent context, and used to gate natural-language deploy actions.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button
                  type="button"
                  variant={agentAccessMode === "ask" ? "default" : "outline"}
                  onClick={() => setAgentAccessMode("ask")}
                >
                  Ask first
                </Button>
                <Button
                  type="button"
                  variant={agentAccessMode === "auto_review" ? "default" : "outline"}
                  onClick={() => setAgentAccessMode("auto_review")}
                >
                  Auto review
                </Button>
                <Button
                  type="button"
                  variant={agentAccessMode === "full_access" ? "default" : "outline"}
                  onClick={() => setAgentAccessMode("full_access")}
                >
                  Full access
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant={remoteTerminalPermission === "ask" ? "default" : "outline"}
                  onClick={() => setRemoteTerminalPermission("ask")}
                >
                  Ask for remote terminal
                </Button>
                <Button
                  type="button"
                  variant={remoteTerminalPermission === "allow" ? "default" : "outline"}
                  onClick={() => setRemoteTerminalPermission("allow")}
                >
                  Allow remote terminal
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {agentAccessMode === "full_access"
                  ? "Full access lets natural-language deploy requests create deployments and queue builds."
                  : "Ask first and Auto review prepare the action plan, then require your explicit approval before real deploy work."}
              </p>
            </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
