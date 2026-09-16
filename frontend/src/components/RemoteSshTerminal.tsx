"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, RefreshCw, TerminalIcon } from "lucide-react";
import { AppIcon } from "@/lib/custom-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readTerminalTheme, useCanvasThemeVersion } from "@/lib/canvas-theme";

interface RemoteSshTerminalProps {
  connectionId: string;
  cwd: string;
  className?: string;
  title?: string;
  connectedInfo?: string;
  onClose?: () => void;
}

function getTerminalWsUrl(connectionId: string, cwd: string) {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090/api/v1";
  const base = new URL(apiBase);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws/ssh-terminal";
  base.search = new URLSearchParams({ connectionId, cwd }).toString();
  return base.toString();
}

function tryParseControlMessage(data: string) {
  if (!data.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(data) as { type?: string; message?: string };
    return parsed.type ? parsed : null;
  } catch {
    return null;
  }
}

export function RemoteSshTerminal({
  connectionId,
  cwd,
  className,
  title,
  connectedInfo,
  onClose,
}: RemoteSshTerminalProps) {
  const themeVersion = useCanvasThemeVersion();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Track the browser's own fullscreen state rather than a local boolean, so
  // pressing Escape (which exits fullscreen without touching our button) does
  // not leave the icon lying about which mode we are in.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await rootRef.current?.requestFullscreen();
      }
      // The ResizeObserver already refits on size change, so xterm reflows to
      // the new dimensions without any extra work here.
    } catch {
      // Fullscreen can be refused by policy or an unsupported browser. Not
      // worth an error toast for a convenience control.
    }
  };
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "closed" | "error">("connecting");
  const [sessionKey, setSessionKey] = useState(0);

  useEffect(() => {
    if (!connectionId || !cwd || !containerRef.current) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let focusHandler: (() => void) | null = null;
    let terminalContainer: HTMLDivElement | null = null;

    async function openTerminal() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (disposed || !containerRef.current) return;
      terminalContainer = containerRef.current;

      setConnectionState("connecting");
      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: "var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 4000,
        scrollOnUserInput: true,
        theme: {
          ...readTerminalTheme(),
          // The ANSI sixteen stay fixed across themes: a program emitting
          // "red" means red, and remapping it would misreport build output.
          black: "#18181b",
          brightBlack: "#71717a",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#eab308",
          blue: "#3b82f6",
          magenta: "#a855f7",
          cyan: "#06b6d4",
          white: "#f4f4f5",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalContainer);
      const fitAndFocus = () => {
        fitAddon.fit();
        terminal.scrollToBottom();
        terminal.focus();
      };
      requestAnimationFrame(fitAndFocus);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      const socket = new WebSocket(getTerminalWsUrl(connectionId, cwd));
      socketRef.current = socket;

      const sendResize = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        }
      };

      socket.addEventListener("open", () => {
        setConnectionState("connected");
        terminal.writeln("\x1b[90mConnected. Use this like a normal SSH terminal.\x1b[0m");
        terminal.scrollToBottom();
        requestAnimationFrame(() => terminal.scrollToBottom());
        sendResize();
      });

      socket.addEventListener("message", async (event) => {
        const data = typeof event.data === "string" ? event.data : await event.data.text();
        const controlMessage = tryParseControlMessage(data);
        if (controlMessage) {
          if (controlMessage.type === "error") {
            setConnectionState("error");
            terminal.writeln(`\r\n\x1b[31m${controlMessage.message || "Terminal error"}\x1b[0m`);
            terminal.scrollToBottom();
          } else if (controlMessage.type === "closed") {
            setConnectionState("closed");
            terminal.writeln(`\r\n\x1b[90m${controlMessage.message || "Terminal closed"}\x1b[0m`);
            terminal.scrollToBottom();
          }
          return;
        }
        terminal.write(data);
        terminal.scrollToBottom();
        requestAnimationFrame(() => terminal.scrollToBottom());
      });

      socket.addEventListener("close", () => {
        setConnectionState((state) => (state === "error" ? "error" : "closed"));
      });

      socket.addEventListener("error", () => {
        setConnectionState("error");
        terminal.writeln("\r\n\x1b[31mTerminal socket failed.\x1b[0m");
        terminal.scrollToBottom();
      });

      terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
        terminal.scrollToBottom();
      });

      resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        terminal.scrollToBottom();
        sendResize();
      });
      resizeObserver.observe(terminalContainer);
      focusHandler = () => terminal.focus();
      terminalContainer.addEventListener("click", focusHandler);
    }

    openTerminal();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (focusHandler && terminalContainer) {
        terminalContainer.removeEventListener("click", focusHandler);
      }
      socketRef.current?.close();
      socketRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connectionId, cwd, sessionKey]);

  // Recolour a terminal that is already open. Without this, switching theme
  // leaves the session on the palette it was created with until reconnect.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = { ...terminal.options.theme, ...readTerminalTheme() };
  }, [themeVersion]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex h-full min-h-[320px] flex-col overflow-hidden rounded-md border border-zinc-800 bg-[#0c0c0c] shadow-2xl",
        // In fullscreen the element is the whole viewport, so the rounded
        // corners and border would draw a box around the screen edge.
        isFullscreen && "min-h-0 rounded-none border-0",
        className
      )}
    >
      <div className="flex h-8 items-center justify-between border-b border-zinc-800 bg-[#18181b] px-2 select-none shrink-0">
        <div className="flex min-w-0 items-center gap-2 text-xs text-white/90">
          <svg className="h-3.5 w-3.5 shrink-0 text-sky-400" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2h-13zm0 1h13a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5z"/>
            <path d="m3.854 5.146 2.5 2.5a.5.5 0 0 1 0 .708l-2.5 2.5a.5.5 0 0 1-.708-.708L5.293 8 3.146 5.854a.5.5 0 1 1 .708-.708zm3 5.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z"/>
          </svg>
          <span className="font-normal font-sans text-xs text-white/90 truncate">
            Windows PowerShell{connectedInfo ? ` - ${connectedInfo}` : title ? ` - ${title}` : ""}
          </span>
          {connectionState !== "connected" && (
            <span className="text-[11px] text-amber-300 font-normal">
              ({connectionState})
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center h-full">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-full rounded-none px-2.5 text-xs font-normal text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => setSessionKey((value) => value + 1)}
            title="Reconnect session"
          >
            <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-1.5 h-3 w-3" />
            Reconnect
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-full w-10 rounded-none text-white/70 hover:bg-white/10 hover:text-white"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Restore" : "Maximize"}
            aria-label={isFullscreen ? "Restore" : "Maximize"}
          >
            {isFullscreen ? (
              <span className="text-xs font-mono select-none">❐</span>
            ) : (
              <span className="text-xs font-mono select-none">□</span>
            )}
          </Button>
          {onClose && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-full w-10 rounded-none text-white/70 hover:bg-[#e81123] hover:text-white transition-colors"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <span className="text-xs font-mono select-none">✕</span>
            </Button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        className="ssh-terminal-surface min-h-0 flex-1 overflow-hidden bg-[#0c0c0c] p-1.5 [&_.xterm-screen]:min-h-full [&_.xterm-viewport]:!overflow-y-auto [&_.xterm]:h-full"
      />
    </div>
  );
}
