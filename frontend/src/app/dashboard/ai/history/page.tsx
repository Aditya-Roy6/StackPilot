"use client";

import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Clock,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { AppIcon } from "@/lib/custom-icons";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface AiChatSession {
  id: string;
  title: string;
  session_type: string;
  status?: string;
  deployment_id?: string;
  preview?: string;
  message_count?: number;
  last_model?: string;
  memory_summary?: string;
  created_at: string;
  updated_at: string;
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function cleanPreview(text?: string | null): string {
  if (!text) return "Continue this conversation.";
  let cleaned = text
    // Replace base64 data URIs
    .replace(/data:image\/[a-zA-Z0-9.+_-]+;base64,[A-Za-z0-9+/=]+/gi, "[image snapshot]")
    // Replace markdown headers
    .replace(/^#+\s+/gm, "")
    // Replace bold/italic markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    // Replace inline code backticks
    .replace(/`([^`]+)`/g, "$1")
    // Replace markdown links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Collapse newlines, carriage returns, and tabs into a single space
    .replace(/[\r\n\t]+/g, " ")
    // Collapse multiple consecutive spaces
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 220) {
    cleaned = cleaned.slice(0, 217).trim() + "...";
  }
  return cleaned || "Continue this conversation.";
}

function sessionTypeLabel(type: string) {
  if (type === "project_chat") return "Project";
  if (type === "sre_incident") return "AI SRE Healing";
  return "Agent";
}

export default function AiHistoryPage() {
  const sessionsQuery = useQuery({
    queryKey: ["ai-chat-sessions"],
    queryFn: async () => {
      const res = await api.get("/ai/sessions");
      const data = res.data as { sessions?: AiChatSession[] };
      return data.sessions || [];
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const sessions = (query.state.data as AiChatSession[] | undefined) || [];
      const hasActiveHealing = sessions.some(
        (s) => s.session_type === "sre_incident" && s.status === "healing"
      );
      return hasActiveHealing ? 3000 : 12000;
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await api.delete(`/ai/sessions/${sessionId}`);
    },
    onSuccess: () => sessionsQuery.refetch(),
  });

  const sessions = sessionsQuery.data || [];
  const totalMessages = sessions.reduce((total, session) => total + (session.message_count || 0), 0);
  const rememberedChats = sessions.filter((session) => (session.memory_summary || "").trim()).length;
  const lastChat = sessions[0]?.updated_at;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 min-w-0 w-full overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/dashboard/ai">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <AppIcon name="arrow-left" fallback={ArrowLeft} className="h-4 w-4"  />
            </Button>
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">AI Chat History</h1>
            <p className="text-sm text-muted-foreground">Resume conversations with their saved context and memory.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => sessionsQuery.refetch()} disabled={sessionsQuery.isFetching}>
            {sessionsQuery.isFetching ? <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  /> : <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-4 w-4"  />}
            Refresh
          </Button>
          <Link href="/dashboard/ai">
            <Button size="sm">
              <AppIcon name="plus" fallback={Plus} className="h-4 w-4"  />
              New chat
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 min-w-0">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AppIcon name="message-square" fallback={MessageSquare} className="h-4 w-4"  />
            Chats
          </div>
          <p className="mt-2 text-3xl font-semibold">{sessions.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AppIcon name="clock" fallback={Clock} className="h-4 w-4"  />
            Messages
          </div>
          <p className="mt-2 text-3xl font-semibold">{totalMessages}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AppIcon name="message-square" fallback={MessageSquare} className="h-4 w-4"  />
            Memory
          </div>
          <p className="mt-2 text-3xl font-semibold">{rememberedChats}</p>
          <p className="mt-1 text-xs text-muted-foreground">{lastChat ? `Latest ${formatDate(lastChat)}` : "No chats yet"}</p>
        </div>
      </div>

      {sessionsQuery.isLoading || (sessionsQuery.isFetching && !sessionsQuery.isFetchedAfterMount) ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card py-20 text-muted-foreground">
          <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-5 w-5 animate-spin"  />
          Loading conversations...
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-14 text-center">
          <AppIcon name="message-square" fallback={MessageSquare} className="mx-auto h-9 w-9 text-muted-foreground/60"  />
          <p className="mt-4 text-sm text-muted-foreground">No chats yet. Start a conversation with the agent.</p>
          <Link href="/dashboard/ai">
            <Button className="mt-5" variant="outline">
              Open agent
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 min-w-0">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="min-w-0 overflow-hidden rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/30"
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 min-w-0">
                <Link href={`/dashboard/ai?session_id=${session.id}`} className="min-w-0 flex-1 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <h2 className="truncate text-lg font-semibold min-w-0 max-w-full">{session.title || "Untitled chat"}</h2>
                    <Badge variant="outline" className="shrink-0">{sessionTypeLabel(session.session_type)}</Badge>
                    {session.session_type === "sre_incident" && session.status === "healing" && (
                      <Badge variant="outline" className="shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 text-amber-400">
                        <AppIcon name="loader2" fallback={Loader2} className="h-3 w-3 animate-spin" />
                        Healing in progress
                      </Badge>
                    )}
                    {session.session_type === "sre_incident" && session.status === "healed" && (
                      <Badge variant="outline" className="shrink-0 gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                        <AppIcon name="check" fallback={Check} className="h-3 w-3" />
                        Healed & Live
                      </Badge>
                    )}
                    {session.session_type === "sre_incident" && session.status === "failed" && (
                      <Badge variant="outline" className="shrink-0 gap-1 border-red-500/40 bg-red-500/10 text-red-400">
                        <AppIcon name="x-circle" fallback={XCircle} className="h-3 w-3" />
                        Healing Failed
                      </Badge>
                    )}
                    {session.last_model && (
                      <Badge variant="secondary" className="max-w-64 truncate shrink-0">
                        {session.last_model}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground break-all [overflow-wrap:anywhere] overflow-hidden">
                    {cleanPreview(session.preview)}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{session.message_count || 0} messages</span>
                    <span>Updated {formatDate(session.updated_at)}</span>
                    {(session.memory_summary || "").trim() && <span>Memory saved</span>}
                  </div>
                </Link>
                <div className="flex items-center gap-2 shrink-0 self-end sm:self-start">
                  <Link href={`/dashboard/ai?session_id=${session.id}`}>
                    <Button variant="outline" size="sm">Continue</Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete chat"
                    disabled={deleteSessionMutation.isPending}
                    onClick={() => deleteSessionMutation.mutate(session.id)}
                  >
                    <AppIcon name="trash2" fallback={Trash2} className="h-4 w-4"  />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
