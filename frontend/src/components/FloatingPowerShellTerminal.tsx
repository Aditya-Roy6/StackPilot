"use client";

import React, { useState, useRef, useEffect, useCallback, memo } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import api from "@/lib/api";

export interface TerminalLogEntry {
  id: string;
  command: string;
  status: "running" | "success" | "error";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  cwd?: string;
  timestamp: string;
}

export interface FloatingPowerShellTerminalProps {
  open: boolean;
  onClose: () => void;
  selectedDeploymentId?: string;
  selectedProjectId?: string;
  initialCommand?: string;
  onInitialCommandConsumed?: () => void;
}

export const FloatingPowerShellTerminal = memo(function FloatingPowerShellTerminal({
  open,
  onClose,
  selectedDeploymentId,
  selectedProjectId,
  initialCommand,
  onInitialCommandConsumed,
}: FloatingPowerShellTerminalProps) {
  const [terminalLogs, setTerminalLogs] = useState<TerminalLogEntry[]>([]);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isExecuting, setIsExecuting] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState("");
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [terminalPos, setTerminalPos] = useState({ x: 40, y: 80 });

  const terminalInputRef = useRef<HTMLInputElement>(null);
  const terminalLogsEndRef = useRef<HTMLDivElement>(null);
  const terminalWindowRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });
  const rafDragRef = useRef<number | null>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        terminalInputRef.current?.focus();
        terminalLogsEndRef.current?.scrollIntoView({ behavior: "instant" });
      }, 50);
    }
  }, [open]);

  // Execute initial command if passed
  useEffect(() => {
    if (open && initialCommand) {
      runCommand(initialCommand);
      onInitialCommandConsumed?.();
    }
  }, [open, initialCommand]);

  // Auto-scroll when logs change
  useEffect(() => {
    if (open) {
      terminalLogsEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [terminalLogs, open]);

  // Silky-smooth RAF dragging that doesn't thrash React render loops
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      if (rafDragRef.current !== null) return;

      rafDragRef.current = requestAnimationFrame(() => {
        rafDragRef.current = null;
        const deltaX = e.clientX - dragStartRef.current.startX;
        const deltaY = e.clientY - dragStartRef.current.startY;
        const newX = Math.max(10, Math.min(window.innerWidth - 120, dragStartRef.current.initialX + deltaX));
        const newY = Math.max(10, Math.min(window.innerHeight - 80, dragStartRef.current.initialY + deltaY));
        setTerminalPos({ x: newX, y: newY });
      });
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      if (rafDragRef.current !== null) {
        cancelAnimationFrame(rafDragRef.current);
        rafDragRef.current = null;
      }
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (rafDragRef.current !== null) {
        cancelAnimationFrame(rafDragRef.current);
      }
    };
  }, []);

  const handleDragStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button") || (e.target as HTMLElement).closest("input")) return;
    if (terminalMaximized) return;

    const rect = terminalWindowRef.current?.getBoundingClientRect();
    if (!rect) return;

    isDraggingRef.current = true;
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: rect.left,
      initialY: rect.top,
    };
  };

  const runCommand = async (cmdToRun: string) => {
    const trimmed = cmdToRun.trim();
    if (!trimmed || isExecuting) return;

    if (trimmed.toLowerCase() === "clear" || trimmed.toLowerCase() === "cls") {
      setTerminalLogs([]);
      setTerminalInput("");
      return;
    }

    const execId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newEntry: TerminalLogEntry = {
      id: execId,
      command: trimmed,
      status: "running",
      cwd: terminalCwd || undefined,
      timestamp: new Date().toLocaleTimeString(),
    };

    setTerminalLogs((prev) => [...prev, newEntry]);
    setTerminalHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);
    setTerminalInput("");
    setIsExecuting(true);

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
      const exitCode = typeof data.exit_code === "number" ? data.exit_code : data.error ? 1 : 0;
      const stdout =
        typeof data.stdout === "string"
          ? data.stdout
          : exitCode === 0 && typeof data.output === "string"
          ? data.output
          : "";
      const stderr =
        typeof data.stderr === "string"
          ? data.stderr
          : exitCode !== 0
          ? typeof data.output === "string"
            ? data.output
            : typeof data.error === "string"
            ? data.error
            : ""
          : "";
      const cwd =
        typeof data.cwd === "string"
          ? data.cwd
          : typeof data.working_directory === "string"
          ? data.working_directory
          : undefined;

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
      setIsExecuting(false);
      setTimeout(() => {
        terminalInputRef.current?.focus();
      }, 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      runCommand(terminalInput);
    }
  };

  if (!open) return null;

  return (
    <div
      ref={terminalWindowRef}
      style={
        terminalMaximized
          ? {
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: "100vw",
              height: "100vh",
              zIndex: 90,
            }
          : {
              position: "fixed",
              left: `${terminalPos.x}px`,
              top: `${terminalPos.y}px`,
              width: "min(680px, 92vw)",
              height: "min(460px, 65vh)",
              zIndex: 60,
            }
      }
      className={cn(
        "rounded-md border border-zinc-800 bg-[#0c0c0c] text-[#cccccc] shadow-2xl flex flex-col overflow-hidden transition-shadow",
        !terminalMaximized && "resize min-w-[360px] min-h-[220px] max-w-[95vw] max-h-[85vh]"
      )}
    >
      {/* Titlebar - Windows PowerShell Black Themed */}
      <div
        onMouseDown={handleDragStart}
        className={cn(
          "flex h-8 items-center justify-between border-b border-zinc-800 bg-[#18181b] px-2 select-none shrink-0",
          !terminalMaximized ? "cursor-grab active:cursor-grabbing" : "cursor-default"
        )}
      >
        <div className="flex items-center gap-2 min-w-0 pointer-events-none text-xs text-white/90">
          <svg className="h-3.5 w-3.5 shrink-0 text-sky-400" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2h-13zm0 1h13a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5z" />
            <path d="m3.854 5.146 2.5 2.5a.5.5 0 0 1 0 .708l-2.5 2.5a.5.5 0 0 1-.708-.708L5.293 8 3.146 5.854a.5.5 0 1 1 .708-.708zm3 5.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z" />
          </svg>
          <span className="font-normal font-sans text-xs text-zinc-200 truncate">
            Windows PowerShell{terminalCwd ? ` - ${terminalCwd}` : ""}
          </span>
        </div>

        {/* Windows Caption Controls */}
        <div className="flex shrink-0 items-center h-full">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-full rounded-none px-2 text-xs font-normal text-zinc-400 hover:bg-white/10 hover:text-white"
            onClick={() => setTerminalLogs([])}
            title="Clear buffer"
          >
            Clear
          </Button>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-full w-10 rounded-none text-zinc-400 hover:bg-white/10 hover:text-white"
            onClick={() => setTerminalMaximized((prev) => !prev)}
            title={terminalMaximized ? "Restore" : "Maximize"}
            aria-label={terminalMaximized ? "Restore" : "Maximize"}
          >
            {terminalMaximized ? (
              <span className="text-xs font-mono select-none">❐</span>
            ) : (
              <span className="text-xs font-mono select-none">□</span>
            )}
          </Button>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-full w-10 rounded-none text-zinc-400 hover:bg-[#e81123] hover:text-white transition-colors"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <span className="text-xs font-mono select-none">✕</span>
          </Button>
        </div>
      </div>

      {/* Black Console Area - click to focus input */}
      <div
        onClick={() => terminalInputRef.current?.focus()}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs font-normal select-text min-h-0 bg-[#0c0c0c] text-[#cccccc] cursor-text leading-relaxed scrollbar-thin"
      >
        {/* Native PowerShell banner */}
        <div className="text-[#888888] font-mono text-xs font-normal pb-2 select-none leading-relaxed">
          Windows PowerShell
          <br />
          Copyright (C) Microsoft Corporation. All rights reserved.
          <br />
          <br />
          Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows
        </div>

        {/* Executed command history */}
        {terminalLogs.map((log) => (
          <div key={log.id} className="space-y-0.5 pt-1">
            <div className="flex items-center gap-1 text-white font-normal">
              <span className="text-zinc-400 select-none">PS C:\{log.cwd || terminalCwd || "workspace"}&gt;</span>
              <span>{log.command}</span>
              {log.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-amber-300 ml-1" />}
            </div>

            {log.stdout && (
              <pre className="whitespace-pre-wrap break-words text-[#cccccc] font-normal leading-relaxed overflow-x-auto text-xs py-0.5 font-mono">
                {log.stdout}
              </pre>
            )}

            {log.stderr && (
              <pre className="whitespace-pre-wrap break-words text-[#e74856] font-normal leading-relaxed overflow-x-auto text-xs py-0.5 font-mono">
                {log.stderr}
              </pre>
            )}
          </div>
        ))}

        {/* Active prompt & input line directly in console */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runCommand(terminalInput);
          }}
          className="flex items-center gap-1.5 pt-1.5"
        >
          <span className="text-zinc-400 font-normal select-none shrink-0 whitespace-nowrap">
            PS C:\{terminalCwd || "workspace"}&gt;
          </span>
          <div className="relative flex-1 flex items-center min-w-0">
            <input
              ref={terminalInputRef}
              type="text"
              value={terminalInput}
              disabled={isExecuting}
              onChange={(e) => setTerminalInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full bg-transparent border-none outline-none text-white font-mono text-xs p-0 m-0 font-normal leading-normal shadow-none focus:ring-0 focus:outline-none"
              spellCheck={false}
              autoComplete="off"
            />
            {isExecuting && <Loader2 className="h-3 w-3 animate-spin text-amber-300 ml-1 shrink-0" />}
          </div>
        </form>
        <div ref={terminalLogsEndRef} />
      </div>
    </div>
  );
});
