"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
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
  ArrowLeft,
  Maximize2,
  Minimize2,
  Wifi,
  BatteryCharging,
  Sliders,
  Layers,
  Download,
  Info,
  CheckCircle2,
} from "lucide-react";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";

interface Deployment {
  id: string;
  project_id: string;
  project_name: string;
  status: string;
  version: string;
  commit_hash?: string;
  runtime_url?: string;
  runtime_snapshot?: {
    runtime_url?: string;
    archetype?: string;
    archetype_details?: string;
    detected_subservices?: string[];
    mobile_metadata?: {
      framework?: string;
      app_name?: string;
      bundle_id?: string;
      sdk_version?: string;
      preview_strategy?: string;
      qr_target_url?: string;
    };
  };
}

type DeviceModel = "iphone16" | "pixel9" | "tablet";
type ZoomMode = "fit" | "100" | "75" | "50";

interface DeviceSpec {
  name: string;
  model: DeviceModel;
  portraitWidth: number;
  portraitHeight: number;
  screenRadius: string;
  outerRadius: string;
  bezelBorder: string;
  bezelColor: string;
  notchType: "dynamic-island" | "punch-hole" | "none";
}

const DEVICE_SPECS: Record<DeviceModel, DeviceSpec> = {
  iphone16: {
    name: "iPhone 16 Pro",
    model: "iphone16",
    portraitWidth: 393,
    portraitHeight: 852,
    screenRadius: "rounded-[48px]",
    outerRadius: "rounded-[54px]",
    bezelBorder: "border-[10px] border-zinc-700/80 shadow-[0_0_0_2px_rgba(255,255,255,0.1),0_25px_60px_-15px_rgba(0,0,0,0.9)]",
    bezelColor: "bg-zinc-900",
    notchType: "dynamic-island",
  },
  pixel9: {
    name: "Pixel 9 Pro",
    model: "pixel9",
    portraitWidth: 412,
    portraitHeight: 860,
    screenRadius: "rounded-[38px]",
    outerRadius: "rounded-[46px]",
    bezelBorder: "border-[9px] border-zinc-700/70 shadow-[0_0_0_2px_rgba(255,255,255,0.08),0_25px_60px_-15px_rgba(0,0,0,0.9)]",
    bezelColor: "bg-zinc-900",
    notchType: "punch-hole",
  },
  tablet: {
    name: "iPad Mini",
    model: "tablet",
    portraitWidth: 744,
    portraitHeight: 960,
    screenRadius: "rounded-[24px]",
    outerRadius: "rounded-[30px]",
    bezelBorder: "border-[14px] border-zinc-700/60 shadow-[0_0_0_2px_rgba(255,255,255,0.08),0_30px_70px_-20px_rgba(0,0,0,0.95)]",
    bezelColor: "bg-zinc-900",
    notchType: "none",
  },
};

export default function MobilePreviewStudioPage() {
  const params = useParams();
  const router = useRouter();
  const deploymentId = params?.id as string;

  const [device, setDevice] = useState<DeviceModel>("iphone16");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [calculatedFitScale, setCalculatedFitScale] = useState<number>(0.85);
  const [copied, setCopied] = useState<boolean>(false);
  const [iframeKey, setIframeKey] = useState<number>(0);
  const [isLoadingIframe, setIsLoadingIframe] = useState<boolean>(true);
  const [showQrPanel, setShowQrPanel] = useState<boolean>(true);

  const canvasRef = useRef<HTMLDivElement>(null);

  // Fetch deployment data
  const { data: deployment, isLoading: isFetchingDeployment } = useQuery<Deployment>({
    queryKey: ["deployment-preview", deploymentId],
    queryFn: async () => {
      const res = await api.get(`/deployments/${deploymentId}`);
      return res.data?.data || res.data;
    },
    enabled: Boolean(deploymentId),
  });

  const rawRuntimeUrl =
    deployment?.runtime_url ||
    deployment?.runtime_snapshot?.runtime_url ||
    "";

  // Resolve runtime URL: default to port 3000 if not set
  const runtimeUrl = useMemo(() => {
    if (rawRuntimeUrl) return rawRuntimeUrl;
    if (typeof window !== "undefined") {
      const host = window.location.hostname;
      return `${window.location.protocol}//${host}:3000`;
    }
    return "http://localhost:3000";
  }, [rawRuntimeUrl]);

  const currentSpec = DEVICE_SPECS[device];

  const deviceWidth =
    orientation === "portrait" ? currentSpec.portraitWidth : currentSpec.portraitHeight;
  const deviceHeight =
    orientation === "portrait" ? currentSpec.portraitHeight : currentSpec.portraitWidth;

  // Auto-calculate fit zoom scale based on window height
  useEffect(() => {
    function recalculateFit() {
      if (!canvasRef.current) return;
      const canvasHeight = canvasRef.current.clientHeight;
      const canvasWidth = canvasRef.current.clientWidth;

      const availHeight = Math.max(300, canvasHeight - 40); // 20px padding top/bottom
      const availWidth = Math.max(300, canvasWidth - 40);

      const scaleH = availHeight / (deviceHeight + 24); // include bezels
      const scaleW = availWidth / (deviceWidth + 24);

      const fit = Math.min(scaleH, scaleW, 1.0);
      setCalculatedFitScale(Math.max(0.4, Number(fit.toFixed(2))));
    }

    recalculateFit();
    window.addEventListener("resize", recalculateFit);
    return () => window.removeEventListener("resize", recalculateFit);
  }, [deviceHeight, deviceWidth, showQrPanel]);

  const currentScale = useMemo(() => {
    if (zoomMode === "100") return 1.0;
    if (zoomMode === "75") return 0.75;
    if (zoomMode === "50") return 0.5;
    return calculatedFitScale;
  }, [zoomMode, calculatedFitScale]);

  const handleCopyUrl = async () => {
    if (!runtimeUrl) return;
    try {
      await navigator.clipboard.writeText(runtimeUrl);
      setCopied(true);
      toast.success("Preview URL copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy URL");
    }
  };

  const handleReload = () => {
    setIsLoadingIframe(true);
    setIframeKey((prev) => prev + 1);
  };

  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
    runtimeUrl
  )}&bgcolor=18181b&color=38bdf8&margin=1`;

  const archetype = deployment?.runtime_snapshot?.archetype || "expo_react_native";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 font-sans text-zinc-100 select-none">
      {/* Top Studio Navbar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800/80 bg-zinc-900/90 px-4 backdrop-blur-md z-30">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/dashboard/deployments")}
            className="h-8 gap-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            title="Back to Deployments"
          >
            <AppIcon name="arrow-left" fallback={ArrowLeft} className="h-4 w-4" />
            <span className="hidden sm:inline text-xs font-medium">Deployments</span>
          </Button>

          <div className="h-4 w-[1px] bg-zinc-800" />

          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20">
              <AppIcon name="smartphone" fallback={Smartphone} className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold tracking-tight text-zinc-100">
                  {deployment?.project_name || "Mobile Simulator Studio"}
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400 py-0 px-1.5"
                >
                  Live Preview
                </Badge>
                {archetype === "expo_react_native" && (
                  <Badge
                    variant="outline"
                    className="border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-400 py-0 px-1.5 hidden md:inline-flex"
                  >
                    Expo PWA
                  </Badge>
                )}
                {archetype === "flutter_mobile" && (
                  <Badge
                    variant="outline"
                    className="border-cyan-500/30 bg-cyan-500/10 text-[10px] text-cyan-400 py-0 px-1.5 hidden md:inline-flex"
                  >
                    Flutter Web
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Center Device & Orientation Controls */}
        <div className="hidden lg:flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/70 p-1">
          <Button
            size="sm"
            variant={device === "iphone16" ? "secondary" : "ghost"}
            onClick={() => setDevice("iphone16")}
            className={`h-7 px-2.5 text-xs ${
              device === "iphone16" ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            iPhone 16 Pro
          </Button>
          <Button
            size="sm"
            variant={device === "pixel9" ? "secondary" : "ghost"}
            onClick={() => setDevice("pixel9")}
            className={`h-7 px-2.5 text-xs ${
              device === "pixel9" ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Pixel 9 Pro
          </Button>
          <Button
            size="sm"
            variant={device === "tablet" ? "secondary" : "ghost"}
            onClick={() => setDevice("tablet")}
            className={`h-7 px-2.5 text-xs ${
              device === "tablet" ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Tablet
          </Button>

          <div className="h-3.5 w-[1px] bg-zinc-800 mx-1" />

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOrientation((prev) => (prev === "portrait" ? "landscape" : "portrait"))}
            className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-100"
            title="Rotate Orientation"
          >
            <AppIcon name="rotate-cw" fallback={RotateCw} className="h-3.5 w-3.5 mr-1" />
            {orientation === "portrait" ? "Portrait" : "Landscape"}
          </Button>

          <div className="h-3.5 w-[1px] bg-zinc-800 mx-1" />

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setZoomMode("fit")}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                zoomMode === "fit" ? "bg-primary text-primary-foreground" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Fit
            </button>
            <button
              onClick={() => setZoomMode("100")}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                zoomMode === "100" ? "bg-primary text-primary-foreground" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              100%
            </button>
            <button
              onClick={() => setZoomMode("75")}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                zoomMode === "75" ? "bg-primary text-primary-foreground" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              75%
            </button>
          </div>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReload}
            className="h-8 w-8 p-0 text-zinc-400 hover:text-zinc-100"
            title="Reload simulator iframe"
          >
            <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowQrPanel((prev) => !prev)}
            className={`h-8 gap-1.5 text-xs ${
              showQrPanel
                ? "bg-primary/20 text-primary border border-primary/30"
                : "text-zinc-400 hover:text-zinc-100"
            }`}
            title="Toggle Expo-Style Physical Device QR Dock"
          >
            <AppIcon name="qr-code" fallback={QrCode} className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Expo QR Dock</span>
          </Button>

          <a
            href={runtimeUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            title="Open raw web application in a new browser tab"
          >
            <AppIcon name="external-link" fallback={ExternalLink} className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Raw App</span>
          </a>
        </div>
      </header>

      {/* Main Studio Area: Device Canvas + Right Dock */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Device Stage with Grid Dot Background */}
        <div
          ref={canvasRef}
          className="flex-1 flex items-center justify-center p-6 overflow-hidden relative bg-[radial-gradient(#27272a_1px,transparent_1px)] [background-size:20px_20px]"
        >
          {isFetchingDeployment ? (
            <div className="flex flex-col items-center gap-3 text-zinc-500">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-xs">Initializing Studio Simulator...</span>
            </div>
          ) : (
            <div
              className="transition-transform duration-300 ease-out origin-center flex items-center justify-center"
              style={{
                transform: `scale(${currentScale})`,
                width: `${deviceWidth + 24}px`,
                height: `${deviceHeight + 24}px`,
              }}
            >
              {/* Smartphone Frame Outer Shell */}
              <div
                className={`relative flex items-center justify-center ${currentSpec.outerRadius} ${currentSpec.bezelBorder} ${currentSpec.bezelColor} transition-all duration-300`}
                style={{
                  width: `${deviceWidth}px`,
                  height: `${deviceHeight}px`,
                }}
              >
                {/* Physical Bezel Edge Highlights */}
                <div className="absolute inset-0 rounded-[inherit] pointer-events-none ring-1 ring-white/10" />

                {/* Device Screen Viewport */}
                <div
                  className={`relative w-full h-full overflow-hidden bg-black ${currentSpec.screenRadius} flex flex-col`}
                >
                  {/* Status Bar */}
                  <div className="relative z-20 flex h-10 w-full shrink-0 items-center justify-between px-6 pt-1 text-[12px] font-medium text-white/90">
                    <span className="font-semibold tracking-tight">9:41</span>

                    {/* Dynamic Island / Punch Hole */}
                    {currentSpec.notchType === "dynamic-island" && (
                      <div className="absolute left-1/2 top-2 -translate-x-1/2 flex h-7 w-28 items-center justify-between rounded-full bg-black px-2.5 shadow-md border border-zinc-800/80">
                        <div className="h-2.5 w-2.5 rounded-full bg-zinc-900 border border-zinc-800" />
                        <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/80 animate-pulse" />
                      </div>
                    )}

                    {currentSpec.notchType === "punch-hole" && (
                      <div className="absolute left-1/2 top-2.5 -translate-x-1/2 h-3.5 w-3.5 rounded-full bg-black border border-zinc-800 shadow-inner" />
                    )}

                    <div className="flex items-center gap-1.5 text-zinc-300">
                      <Wifi className="h-3 w-3" />
                      <BatteryCharging className="h-3.5 w-3.5" />
                    </div>
                  </div>

                  {/* Live Web Application Iframe */}
                  <div className="relative flex-1 w-full h-full bg-zinc-950 overflow-hidden">
                    {isLoadingIframe && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/80 backdrop-blur-sm gap-2">
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        <span className="text-xs text-zinc-400">Loading mobile viewport...</span>
                      </div>
                    )}

                    <iframe
                      key={iframeKey}
                      src={runtimeUrl}
                      onLoad={() => setIsLoadingIframe(false)}
                      title="StackPilot Mobile Simulator"
                      className="w-full h-full border-0 bg-zinc-950"
                      allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; microphone; midi; clipboard-read; clipboard-write;"
                    />
                  </div>

                  {/* Home Indicator Bar */}
                  <div className="relative z-20 flex h-5 w-full shrink-0 items-center justify-center pb-1">
                    <div className="h-1 w-32 rounded-full bg-white/40" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Dock: Expo-Style Dynamic QR Code & Sideload Center */}
        {showQrPanel && (
          <aside className="w-80 shrink-0 border-l border-zinc-800 bg-zinc-900/95 p-5 flex flex-col gap-5 overflow-y-auto z-20 backdrop-blur-md">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-primary">
                  Expo-Style QR Dock
                </span>
                <Badge
                  variant="outline"
                  className="border-primary/40 bg-primary/10 text-[10px] text-primary"
                >
                  Physical Testing
                </Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
                Scan with your physical iPhone or Android camera to run and interact with this deployment instantly over local WiFi or LAN.
              </p>
            </div>

            {/* QR Code Container */}
            <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-xl">
              <div className="relative rounded-lg overflow-hidden border border-zinc-800 p-1 bg-zinc-900">
                <img
                  src={qrImageUrl}
                  alt="Physical Device QR Code"
                  width={210}
                  height={210}
                  className="rounded-md"
                />
              </div>

              <div className="mt-3 flex items-center gap-1 text-[11px] text-zinc-400">
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                <span>Compatible with iOS Camera & Expo Go</span>
              </div>
            </div>

            {/* Direct URL & Copy */}
            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                Live URL
              </label>
              <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5">
                <input
                  type="text"
                  readOnly
                  value={runtimeUrl}
                  className="flex-1 bg-transparent px-1.5 text-xs text-zinc-300 outline-none font-mono select-all"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleCopyUrl}
                  className="h-7 px-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>

            {/* Archetype & Runtime Specs */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3.5 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
                <Info className="h-3.5 w-3.5 text-primary" />
                <span>Environment Specs</span>
              </div>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex justify-between text-zinc-400">
                  <span>Archetype:</span>
                  <span className="font-mono text-zinc-200 uppercase">{archetype}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Viewport:</span>
                  <span className="font-mono text-zinc-200">
                    {deviceWidth} × {deviceHeight} px
                  </span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Zoom Scale:</span>
                  <span className="font-mono text-zinc-200">
                    {Math.round(currentScale * 100)}%
                  </span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Touch Emulation:</span>
                  <span className="text-emerald-400 font-medium">Active</span>
                </div>
              </div>
            </div>

            {/* Quick Sideload APK button if Native Android */}
            {(archetype === "native_android" || archetype === "android_gradle") && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                  <Download className="h-4 w-4" />
                  <span>Download Android APK</span>
                </div>
                <p className="text-[11px] text-zinc-300">
                  Direct debug APK generated from Gradle build. Sideload directly to any Android device.
                </p>
                <a
                  href={`${runtimeUrl}/app-debug.apk`}
                  download
                  className="flex items-center justify-center gap-1.5 w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-zinc-950 font-semibold text-xs py-2 transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download APK
                </a>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
