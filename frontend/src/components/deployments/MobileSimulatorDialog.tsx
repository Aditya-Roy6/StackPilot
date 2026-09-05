"use client";

import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Smartphone,
  Tablet,
  RotateCw,
  ExternalLink,
  Copy,
  Check,
  QrCode,
  RefreshCw,
  Globe,
} from "lucide-react";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";

interface MobileSimulatorDialogProps {
  open: boolean;
  onClose: () => void;
  deploymentTitle: string;
  runtimeUrl: string;
  archetype?: string;
}

type DeviceModel = "iphone16" | "pixel9" | "tablet";

export function MobileSimulatorDialog({
  open,
  onClose,
  deploymentTitle,
  runtimeUrl,
  archetype,
}: MobileSimulatorDialogProps) {
  const [device, setDevice] = useState<DeviceModel>("iphone16");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [showQr, setShowQr] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [iframeKey, setIframeKey] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const reloadIframe = () => {
    setIsLoading(true);
    setIframeKey((prev) => prev + 1);
  };

  const handleCopyUrl = async () => {
    if (!runtimeUrl) return;
    try {
      await navigator.clipboard.writeText(runtimeUrl);
      setCopied(true);
      toast.success("Preview URL copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy URL");
    }
  };

  const getDimensions = () => {
    if (device === "tablet") {
      return orientation === "portrait"
        ? { width: 768, height: 960, scale: 0.62 }
        : { width: 960, height: 768, scale: 0.58 };
    }
    if (device === "pixel9") {
      return orientation === "portrait"
        ? { width: 412, height: 860, scale: 0.74 }
        : { width: 860, height: 412, scale: 0.65 };
    }
    // iPhone 16 Pro
    return orientation === "portrait"
      ? { width: 393, height: 852, scale: 0.74 }
      : { width: 852, height: 393, scale: 0.65 };
  };

  const dim = getDimensions();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!flex !w-[min(96vw,84rem)] !max-w-[84rem] !max-h-[94vh] !flex-col overflow-hidden rounded-2xl border-border bg-card p-0 shadow-2xl">
        {/* Header Bar */}
        <DialogHeader className="shrink-0 border-b border-border/80 bg-muted/20 px-6 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <AppIcon name="smartphone" fallback={Smartphone} className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="flex items-center gap-2 text-base font-bold">
                  Mobile Simulator & Preview
                  {archetype === "expo_react_native" && (
                    <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-400 text-[11px] font-medium">
                      Expo Web PWA
                    </Badge>
                  )}
                  {archetype === "flutter_mobile" && (
                    <Badge variant="outline" className="border-cyan-500/40 bg-cyan-500/10 text-cyan-400 text-[11px] font-medium">
                      Flutter Web
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground truncate max-w-[28rem]">
                  {deploymentTitle} • Live touch-accurate device emulation
                </DialogDescription>
              </div>
            </div>

            {/* Device & Controls Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Device Selector */}
              <div className="flex items-center rounded-lg border border-border bg-background p-0.5">
                <Button
                  variant={device === "iphone16" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setDevice("iphone16")}
                  className="h-7 px-2.5 text-xs gap-1.5"
                >
                  <AppIcon name="smartphone" fallback={Smartphone} className="h-3.5 w-3.5" />
                  iPhone 16 Pro
                </Button>
                <Button
                  variant={device === "pixel9" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setDevice("pixel9")}
                  className="h-7 px-2.5 text-xs gap-1.5"
                >
                  <AppIcon name="smartphone" fallback={Smartphone} className="h-3.5 w-3.5" />
                  Pixel 9
                </Button>
                <Button
                  variant={device === "tablet" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setDevice("tablet")}
                  className="h-7 px-2.5 text-xs gap-1.5"
                >
                  <AppIcon name="tablet" fallback={Tablet} className="h-3.5 w-3.5" />
                  Tablet
                </Button>
              </div>

              {/* Orientation Toggle */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOrientation((prev) => (prev === "portrait" ? "landscape" : "portrait"))}
                className="h-8 gap-1.5 text-xs border-border bg-background"
                title="Rotate device"
              >
                <AppIcon name="rotate-cw" fallback={RotateCw} className="h-3.5 w-3.5" />
                <span className="capitalize">{orientation}</span>
              </Button>

              {/* Physical Phone QR Code Button */}
              <Button
                variant={showQr ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowQr((prev) => !prev)}
                className="h-8 gap-1.5 text-xs border-primary/30 text-primary hover:bg-primary/10"
              >
                <AppIcon name="qr-code" fallback={QrCode} className="h-3.5 w-3.5" />
                {showQr ? "Hide QR" : "Scan on Phone"}
              </Button>

              {/* External open */}
              {runtimeUrl && (
                <a
                  href={runtimeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <AppIcon name="external-link" fallback={ExternalLink} className="h-3.5 w-3.5" />
                  Open Tab
                </a>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Content Body */}
        <div className="relative flex flex-1 items-center justify-center overflow-y-auto bg-dot-pattern bg-zinc-950/90 p-4 sm:p-6 min-h-[580px]">
          {/* QR Code Floating Card */}
          {showQr && (
            <div className="absolute right-6 top-6 z-30 w-72 rounded-xl border border-primary/30 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95">
              <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <AppIcon name="qr-code" fallback={QrCode} className="h-3.5 w-3.5 text-primary" />
                  Scan with Camera
                </span>
                <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-400 bg-emerald-500/10">
                  Live
                </Badge>
              </div>
              <div className="mt-3 flex justify-center rounded-lg bg-white p-3 shadow-inner">
                {runtimeUrl ? (
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(runtimeUrl)}`}
                    alt="Scan preview on physical mobile device"
                    className="h-40 w-40 rounded-md object-contain"
                  />
                ) : (
                  <div className="h-40 w-40 flex items-center justify-center text-xs text-zinc-500">
                    No runtime URL available
                  </div>
                )}
              </div>
              <p className="mt-2.5 text-center text-[11px] text-zinc-400">
                Point your phone camera at this QR code to test on your real physical device.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyUrl}
                  className="w-full text-xs h-7 gap-1 border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                >
                  {copied ? <AppIcon name="check" fallback={Check} className="h-3 w-3 text-emerald-400" /> : <AppIcon name="copy" fallback={Copy} className="h-3 w-3" />}
                  {copied ? "Copied" : "Copy URL"}
                </Button>
              </div>
            </div>
          )}

          {/* Interactive Smartphone / Tablet Bezel Frame */}
          <div
            className="transition-all duration-300 ease-out flex flex-col items-center justify-center"
            style={{
              transform: `scale(${dim.scale})`,
              transformOrigin: "center center",
            }}
          >
            <div
              className={`relative bg-zinc-950 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.9)] ring-1 ring-white/10 ${
                device === "iphone16"
                  ? "rounded-[52px] border-[12px] border-zinc-800"
                  : device === "pixel9"
                  ? "rounded-[42px] border-[10px] border-zinc-700"
                  : "rounded-[28px] border-[12px] border-zinc-800"
              }`}
              style={{
                width: `${dim.width}px`,
                height: `${dim.height}px`,
              }}
            >
              {/* Dynamic Island (iPhone) or Hole Punch (Pixel) */}
              {device === "iphone16" && orientation === "portrait" && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 h-[30px] w-[120px] rounded-full bg-black shadow-md flex items-center justify-between px-3">
                  <div className="h-2.5 w-2.5 rounded-full bg-zinc-900 ring-1 ring-zinc-800" />
                  <div className="h-3 w-3 rounded-full bg-zinc-900/90 ring-1 ring-blue-900/50 flex items-center justify-center">
                    <div className="h-1.5 w-1.5 rounded-full bg-blue-500/80" />
                  </div>
                </div>
              )}

              {device === "pixel9" && orientation === "portrait" && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 h-3.5 w-3.5 rounded-full bg-black ring-1 ring-zinc-700 flex items-center justify-center">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-900/60" />
                </div>
              )}

              {/* Status Bar / Browser Address Bar inside frame */}
              <div className="h-12 w-full bg-zinc-900/90 backdrop-blur border-b border-zinc-800 flex items-center justify-between px-4 z-10 select-none">
                <div className="flex items-center gap-2 truncate max-w-[70%]">
                  <Globe className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  <span className="text-[11px] font-mono text-zinc-300 truncate">
                    {runtimeUrl ? new URL(runtimeUrl).hostname : "localhost:3000"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={reloadIframe}
                    className="p-1 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                    title="Reload"
                  >
                    <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin text-primary" : ""}`} />
                  </button>
                  <button
                    onClick={handleCopyUrl}
                    className="p-1 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                    title="Copy URL"
                  >
                    {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
              </div>

              {/* Iframe Viewport Container */}
              <div className="w-full h-[calc(100%-48px)] bg-white relative overflow-hidden">
                {runtimeUrl ? (
                  <iframe
                    key={iframeKey}
                    src={runtimeUrl}
                    className="w-full h-full border-0"
                    onLoad={() => setIsLoading(false)}
                    title="Mobile Viewport Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center p-6 text-center text-zinc-500 bg-zinc-900">
                    <Smartphone className="h-12 w-12 text-zinc-600 mb-3" />
                    <p className="font-medium text-sm text-zinc-300">No active runtime URL</p>
                    <p className="text-xs text-zinc-500 mt-1 max-w-[20rem]">
                      Deploy or run this container to preview its mobile responsive interface.
                    </p>
                  </div>
                )}

                {/* Bottom Home Indicator Bar (iOS) */}
                {device === "iphone16" && (
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 h-1 w-32 rounded-full bg-zinc-900/60 pointer-events-none" />
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
