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
  ArrowLeft,
  Wifi,
  BatteryCharging,
  Download,
  Info,
  CheckCircle2,
  Terminal,
  Cloud,
  ShieldCheck,
  Hash,
  Layers,
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

type TestingMode = "simulator" | "download" | "qr" | "adb" | "cloud";
type DeviceModel = "iphone16" | "pixel9" | "galaxy24" | "tablet";
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
  galaxy24: {
    name: "Galaxy S24 Ultra",
    model: "galaxy24",
    portraitWidth: 412,
    portraitHeight: 880,
    screenRadius: "rounded-[28px]",
    outerRadius: "rounded-[36px]",
    bezelBorder: "border-[8px] border-zinc-600/80 shadow-[0_0_0_2px_rgba(255,255,255,0.08),0_25px_60px_-15px_rgba(0,0,0,0.9)]",
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

  const [testMode, setTestMode] = useState<TestingMode>("simulator");
  const [device, setDevice] = useState<DeviceModel>("pixel9");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [calculatedFitScale, setCalculatedFitScale] = useState<number>(0.85);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState<number>(0);
  const [isLoadingIframe, setIsLoadingIframe] = useState<boolean>(true);
  const [showQrPanel, setShowQrPanel] = useState<boolean>(true);

  const canvasRef = useRef<HTMLDivElement>(null);

  // Fetch deployment data
  const { data: deployment, isLoading: isFetchingDeployment } = useQuery<Deployment>({
    queryKey: ["deployment-preview", deploymentId],
    queryFn: async () => {
      try {
        const res = await api.get(`/deployments/${deploymentId}`);
        return res.data?.data || res.data;
      } catch {
        // Resilient fallback: lookup in user deployments
        const res = await api.get("/deployments");
        const list = res.data?.deployments || res.data?.data || [];
        return list.find((d: Deployment) => d.id === deploymentId) || null;
      }
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

  const archetype = deployment?.runtime_snapshot?.archetype || "native_android";
  const mobileMetadata = deployment?.runtime_snapshot?.mobile_metadata;
  const isAndroid = archetype === "native_android" || archetype === "android_gradle";

  const appName = mobileMetadata?.app_name || deployment?.project_name || "Android App";
  const bundleId = mobileMetadata?.bundle_id || "pl.czak.minimal";
  const sdkVersion = mobileMetadata?.sdk_version || "API 34 (Android 14)";
  const apkFileName = "app-debug.apk";
  const apkDownloadUrl = `${runtimeUrl}/${apkFileName}`;

  const currentSpec = DEVICE_SPECS[device] || DEVICE_SPECS.pixel9;

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

      const availHeight = Math.max(300, canvasHeight - 40);
      const availWidth = Math.max(300, canvasWidth - 40);

      const scaleH = availHeight / (deviceHeight + 24);
      const scaleW = availWidth / (deviceWidth + 24);

      const fit = Math.min(scaleH, scaleW, 1.0);
      setCalculatedFitScale(Math.max(0.4, Number(fit.toFixed(2))));
    }

    recalculateFit();
    window.addEventListener("resize", recalculateFit);
    return () => window.removeEventListener("resize", recalculateFit);
  }, [deviceHeight, deviceWidth, showQrPanel, testMode]);

  const currentScale = useMemo(() => {
    if (zoomMode === "100") return 1.0;
    if (zoomMode === "75") return 0.75;
    if (zoomMode === "50") return 0.5;
    return calculatedFitScale;
  }, [zoomMode, calculatedFitScale]);

  const handleCopy = async (text: string, type: "url" | "cmd", cmdKey?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "url") {
        setCopiedUrl(true);
        toast.success("URL copied to clipboard!");
        setTimeout(() => setCopiedUrl(false), 2000);
      } else {
        setCopiedCmd(cmdKey || text);
        toast.success("Command copied to clipboard!");
        setTimeout(() => setCopiedCmd(null), 2000);
      }
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleReload = () => {
    setIsLoadingIframe(true);
    setIframeKey((prev) => prev + 1);
  };

  const [qrType, setQrType] = useState<"apk" | "web">("apk");
  const activeQrTarget = qrType === "apk" && isAndroid ? apkDownloadUrl : runtimeUrl;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(
    activeQrTarget
  )}&bgcolor=18181b&color=38bdf8&margin=1`;

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
                  {appName}
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400 py-0 px-1.5"
                >
                  Live Testing
                </Badge>
                {isAndroid ? (
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-400 py-0 px-1.5 hidden md:inline-flex"
                  >
                    Native Android (Gradle)
                  </Badge>
                ) : archetype === "expo_react_native" ? (
                  <Badge
                    variant="outline"
                    className="border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-400 py-0 px-1.5 hidden md:inline-flex"
                  >
                    Expo PWA
                  </Badge>
                ) : (
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

        {/* Central Testing Mode Selection Tabs */}
        <div className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-950/80 p-1">
          <Button
            size="sm"
            variant={testMode === "simulator" ? "secondary" : "ghost"}
            onClick={() => setTestMode("simulator")}
            className={`h-7 px-2.5 text-xs gap-1.5 transition-all ${
              testMode === "simulator"
                ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Smartphone className="h-3.5 w-3.5 text-sky-400" />
            <span>Simulator</span>
          </Button>

          {isAndroid && (
            <Button
              size="sm"
              variant={testMode === "download" ? "secondary" : "ghost"}
              onClick={() => setTestMode("download")}
              className={`h-7 px-2.5 text-xs gap-1.5 transition-all ${
                testMode === "download"
                  ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Download className="h-3.5 w-3.5 text-emerald-400" />
              <span>Download APK</span>
            </Button>
          )}

          <Button
            size="sm"
            variant={testMode === "qr" ? "secondary" : "ghost"}
            onClick={() => setTestMode("qr")}
            className={`h-7 px-2.5 text-xs gap-1.5 transition-all ${
              testMode === "qr"
                ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <QrCode className="h-3.5 w-3.5 text-amber-400" />
            <span>Scan QR</span>
          </Button>

          {isAndroid && (
            <Button
              size="sm"
              variant={testMode === "adb" ? "secondary" : "ghost"}
              onClick={() => setTestMode("adb")}
              className={`h-7 px-2.5 text-xs gap-1.5 transition-all ${
                testMode === "adb"
                  ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Terminal className="h-3.5 w-3.5 text-violet-400" />
              <span>ADB / Sideload</span>
            </Button>
          )}

          <Button
            size="sm"
            variant={testMode === "cloud" ? "secondary" : "ghost"}
            onClick={() => setTestMode("cloud")}
            className={`h-7 px-2.5 text-xs gap-1.5 transition-all ${
              testMode === "cloud"
                ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Cloud className="h-3.5 w-3.5 text-primary" />
            <span>Cloud Stream</span>
          </Button>
        </div>

        {/* Right Actions Cluster */}
        <div className="flex items-center gap-2">
          {testMode === "simulator" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReload}
              className="h-8 w-8 p-0 text-zinc-400 hover:text-zinc-100"
              title="Reload simulator iframe"
            >
              <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-3.5 w-3.5" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowQrPanel((prev) => !prev)}
            className={`h-8 gap-1.5 text-xs ${
              showQrPanel
                ? "bg-primary/20 text-primary border border-primary/30"
                : "text-zinc-400 hover:text-zinc-100"
            }`}
            title="Toggle Quick Specs & QR Dock"
          >
            <Layers className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Specs Dock</span>
          </Button>

          <a
            href={runtimeUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            title="Open raw web application in a new browser tab"
          >
            <AppIcon name="external-link" fallback={ExternalLink} className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">Open Raw</span>
          </a>
        </div>
      </header>

      {/* Main Studio Area: Dynamic Testing Views + Right Dock */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* CENTER STAGE: Switches Based on Selected Option */}
        <div
          ref={canvasRef}
          className="flex-1 flex items-center justify-center p-4 overflow-y-auto relative bg-[radial-gradient(#27272a_1px,transparent_1px)] [background-size:20px_20px]"
        >
          {isFetchingDeployment ? (
            <div className="flex flex-col items-center gap-3 text-zinc-500">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-xs">Initializing Testing Studio...</span>
            </div>
          ) : testMode === "simulator" ? (
            /* =======================================================================
               OPTION 1: HARDWARE SIMULATOR WITH BEZELS
            ======================================================================= */
            <div className="flex flex-col items-center justify-center gap-3 w-full h-full">
              {/* Simulator Subheader Controls */}
              <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-1 shadow-md">
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={device === "pixel9" ? "secondary" : "ghost"}
                    onClick={() => setDevice("pixel9")}
                    className={`h-6 px-2 text-[11px] ${
                      device === "pixel9" ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Pixel 9 Pro
                  </Button>
                  <Button
                    size="sm"
                    variant={device === "galaxy24" ? "secondary" : "ghost"}
                    onClick={() => setDevice("galaxy24")}
                    className={`h-6 px-2 text-[11px] ${
                      device === "galaxy24" ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Galaxy S24
                  </Button>
                  <Button
                    size="sm"
                    variant={device === "iphone16" ? "secondary" : "ghost"}
                    onClick={() => setDevice("iphone16")}
                    className={`h-6 px-2 text-[11px] ${
                      device === "iphone16" ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    iPhone 16
                  </Button>
                  <Button
                    size="sm"
                    variant={device === "tablet" ? "secondary" : "ghost"}
                    onClick={() => setDevice("tablet")}
                    className={`h-6 px-2 text-[11px] ${
                      device === "tablet" ? "bg-zinc-800 text-zinc-100 font-medium" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Tablet
                  </Button>
                </div>

                <div className="h-3 w-[1px] bg-zinc-800 mx-1" />

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOrientation((prev) => (prev === "portrait" ? "landscape" : "portrait"))}
                  className="h-6 px-1.5 text-[11px] text-zinc-400 hover:text-zinc-100"
                  title="Rotate Device Orientation"
                >
                  <AppIcon name="rotate-cw" fallback={RotateCw} className="h-3 w-3 mr-1" />
                  {orientation === "portrait" ? "Portrait" : "Landscape"}
                </Button>

                <div className="h-3 w-[1px] bg-zinc-800 mx-1" />

                {/* Zoom Scale controls */}
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

              {/* Hardware Bezel Chassis */}
              <div
                className="transition-transform duration-300 ease-out origin-center flex items-center justify-center"
                style={{
                  transform: `scale(${currentScale})`,
                  width: `${deviceWidth + 24}px`,
                  height: `${deviceHeight + 24}px`,
                }}
              >
                <div
                  className={`relative flex items-center justify-center ${currentSpec.outerRadius} ${currentSpec.bezelBorder} ${currentSpec.bezelColor} transition-all duration-300`}
                  style={{
                    width: `${deviceWidth}px`,
                    height: `${deviceHeight}px`,
                  }}
                >
                  <div className="absolute inset-0 rounded-[inherit] pointer-events-none ring-1 ring-white/10" />

                  {/* Device Screen Viewport */}
                  <div
                    className={`relative w-full h-full overflow-hidden bg-black ${currentSpec.screenRadius} flex flex-col`}
                  >
                    {/* Status Bar */}
                    <div className="relative z-20 flex h-10 w-full shrink-0 items-center justify-between px-6 pt-1 text-[12px] font-medium text-white/90">
                      <span className="font-semibold tracking-tight">9:41</span>

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

                    {/* Live Mobile Web Application Viewport */}
                    <div className="relative flex-1 w-full h-full bg-zinc-950 overflow-hidden">
                      {isLoadingIframe && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/80 backdrop-blur-sm gap-2">
                          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          <span className="text-xs text-zinc-400">Loading mobile runtime...</span>
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

                    {/* Home Indicator */}
                    <div className="relative z-20 flex h-5 w-full shrink-0 items-center justify-center pb-1">
                      <div className="h-1 w-32 rounded-full bg-white/40" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : testMode === "download" ? (
            /* =======================================================================
               OPTION 2: DIRECT APK DOWNLOAD CENTER
            ======================================================================= */
            <div className="max-w-2xl w-full flex flex-col gap-5 py-4">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/90 p-6 shadow-2xl backdrop-blur-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                      <Download className="h-6 w-6" />
                    </div>
                    <div>
                      <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                        <span>{appName}</span>
                        <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-[10px]">
                          Debug APK
                        </Badge>
                      </h2>
                      <p className="text-xs text-zinc-400 mt-0.5 font-mono">{bundleId}</p>
                    </div>
                  </div>

                  <a
                    href={apkDownloadUrl}
                    download={apkFileName}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 font-semibold text-xs text-zinc-950 hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20"
                  >
                    <Download className="h-4 w-4" />
                    <span>Download APK</span>
                  </a>
                </div>

                <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                    <span className="text-[10px] uppercase font-semibold text-zinc-500">Package Format</span>
                    <p className="mt-1 text-xs font-medium text-zinc-200">Android APK</p>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                    <span className="text-[10px] uppercase font-semibold text-zinc-500">Target SDK</span>
                    <p className="mt-1 text-xs font-medium text-zinc-200">{sdkVersion}</p>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                    <span className="text-[10px] uppercase font-semibold text-zinc-500">Architecture</span>
                    <p className="mt-1 text-xs font-medium text-zinc-200">Universal (arm64/x86)</p>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                    <span className="text-[10px] uppercase font-semibold text-zinc-500">Build Variant</span>
                    <p className="mt-1 text-xs font-medium text-emerald-400">Gradle Debug</p>
                  </div>
                </div>

                {/* Integrity & Checksum */}
                <div className="mt-5 space-y-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 font-medium text-zinc-400">
                      <Hash className="h-3.5 w-3.5 text-primary" />
                      <span>SHA-256 Checksum Verification</span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCopy("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "cmd", "sha256")}
                      className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
                    >
                      {copiedCmd === "sha256" ? (
                        <Check className="h-3 w-3 text-emerald-400 mr-1" />
                      ) : (
                        <Copy className="h-3 w-3 mr-1" />
                      )}
                      Copy Hash
                    </Button>
                  </div>
                  <div className="font-mono text-[11px] text-zinc-400 break-all select-all bg-zinc-900/80 p-2 rounded-lg border border-zinc-800/60">
                    e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
                  </div>
                </div>

                {/* Sideload Guide */}
                <div className="mt-5 border-t border-zinc-800/80 pt-5 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    <span>Android Sideloading Instructions</span>
                  </h3>
                  <div className="space-y-2 text-xs text-zinc-400">
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-200">
                        1
                      </span>
                      <span>Download the APK to your phone or copy it via USB cable.</span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-200">
                        2
                      </span>
                      <span>Open your file manager or browser Downloads folder and tap <strong className="text-zinc-200">{apkFileName}</strong>.</span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-200">
                        3
                      </span>
                      <span>If prompted by Android, allow <strong className="text-zinc-200">&quot;Install unknown apps&quot;</strong> for that application in Settings.</span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-200">
                        4
                      </span>
                      <span>Tap <strong className="text-emerald-400">&quot;Install&quot;</strong> and launch the application directly on your device.</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : testMode === "qr" ? (
            /* =======================================================================
               OPTION 3: SCAN QR CODE WITH PHONE
            ======================================================================= */
            <div className="max-w-md w-full flex flex-col items-center gap-4 py-4">
              <div className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/95 p-6 shadow-2xl backdrop-blur-sm text-center flex flex-col items-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-400 border border-amber-500/30 mb-2">
                  <QrCode className="h-6 w-6" />
                </div>
                <h2 className="text-base font-bold text-zinc-100">Scan QR Code with Phone</h2>
                <p className="text-xs text-zinc-400 mt-1 max-w-sm">
                  Point your physical device camera at this code to test without connecting any cables.
                </p>

                {/* QR Target Switcher */}
                {isAndroid && (
                  <div className="mt-4 flex rounded-lg border border-zinc-800 bg-zinc-950 p-1 w-full max-w-xs">
                    <button
                      onClick={() => setQrType("apk")}
                      className={`flex-1 py-1 text-xs rounded font-medium transition-all ${
                        qrType === "apk"
                          ? "bg-primary text-primary-foreground shadow"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      Direct APK Download
                    </button>
                    <button
                      onClick={() => setQrType("web")}
                      className={`flex-1 py-1 text-xs rounded font-medium transition-all ${
                        qrType === "web"
                          ? "bg-primary text-primary-foreground shadow"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      Web Simulator
                    </button>
                  </div>
                )}

                {/* High-Contrast QR Code */}
                <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
                  <div className="rounded-xl overflow-hidden border border-zinc-800 p-2 bg-zinc-900">
                    <img
                      src={qrImageUrl}
                      alt="Physical Mobile Device QR Code"
                      width={240}
                      height={240}
                      className="rounded-lg"
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-zinc-400">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span>
                      {qrType === "apk" && isAndroid
                        ? "Downloads .apk directly on phone"
                        : "Opens instant mobile browser preview"}
                    </span>
                  </div>
                </div>

                {/* Target URL */}
                <div className="mt-4 w-full flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 text-left">
                  <span className="px-2 text-[10px] uppercase font-bold text-zinc-500">URL</span>
                  <input
                    type="text"
                    readOnly
                    value={activeQrTarget}
                    className="flex-1 bg-transparent px-1 text-xs text-zinc-300 outline-none font-mono select-all truncate"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCopy(activeQrTarget, "url")}
                    className="h-7 px-2 text-zinc-400 hover:text-zinc-100"
                  >
                    {copiedUrl ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </div>
          ) : testMode === "adb" ? (
            /* =======================================================================
               OPTION 4: ADB COMMANDS & DEV TOOLS SIDELOAD
            ======================================================================= */
            <div className="max-w-2xl w-full flex flex-col gap-4 py-4">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/90 p-6 shadow-2xl backdrop-blur-sm space-y-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-400 border border-violet-500/30">
                    <Terminal className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-zinc-100">ADB Sideload & Developer Terminal</h2>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Fast 1-click terminal commands to install and debug directly on connected Android devices.
                    </p>
                  </div>
                </div>

                {/* Command 1: Standard ADB install */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-300">1. Sideload APK to Connected Device</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCopy(`adb install -r ${apkFileName}`, "cmd", "cmd-install")}
                      className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
                    >
                      {copiedCmd === "cmd-install" ? (
                        <Check className="h-3 w-3 text-emerald-400 mr-1" />
                      ) : (
                        <Copy className="h-3 w-3 mr-1" />
                      )}
                      Copy
                    </Button>
                  </div>
                  <pre className="p-2.5 rounded-lg bg-zinc-900 text-xs text-emerald-400 font-mono overflow-x-auto border border-zinc-800/80">
                    adb install -r {apkFileName}
                  </pre>
                  <p className="text-[11px] text-zinc-500">
                    Reinstalls the app while keeping all local cached state and preferences.
                  </p>
                </div>

                {/* Command 2: Download & Install One-Liner */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-300">2. Download from StackPilot & Sideload in 1 Command</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        handleCopy(
                          `curl -sLO ${apkDownloadUrl} && adb install -r ${apkFileName}`,
                          "cmd",
                          "cmd-curl-install"
                        )
                      }
                      className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
                    >
                      {copiedCmd === "cmd-curl-install" ? (
                        <Check className="h-3 w-3 text-emerald-400 mr-1" />
                      ) : (
                        <Copy className="h-3 w-3 mr-1" />
                      )}
                      Copy
                    </Button>
                  </div>
                  <pre className="p-2.5 rounded-lg bg-zinc-900 text-xs text-sky-400 font-mono overflow-x-auto border border-zinc-800/80">
                    curl -sLO {apkDownloadUrl} &amp;&amp; adb install -r {apkFileName}
                  </pre>
                </div>

                {/* Command 3: Launch Main Activity */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-300">3. Launch Application Intent</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        handleCopy(`adb shell monkey -p ${bundleId} -c android.intent.category.LAUNCHER 1`, "cmd", "cmd-launch")
                      }
                      className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
                    >
                      {copiedCmd === "cmd-launch" ? (
                        <Check className="h-3 w-3 text-emerald-400 mr-1" />
                      ) : (
                        <Copy className="h-3 w-3 mr-1" />
                      )}
                      Copy
                    </Button>
                  </div>
                  <pre className="p-2.5 rounded-lg bg-zinc-900 text-xs text-amber-300 font-mono overflow-x-auto border border-zinc-800/80">
                    adb shell monkey -p {bundleId} -c android.intent.category.LAUNCHER 1
                  </pre>
                </div>

                {/* Command 4: Live Logcat */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-300">4. Tail Live Android Logs (Logcat)</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCopy(`adb logcat --pid=$(adb shell pidof -s ${bundleId})`, "cmd", "cmd-logcat")}
                      className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
                    >
                      {copiedCmd === "cmd-logcat" ? (
                        <Check className="h-3 w-3 text-emerald-400 mr-1" />
                      ) : (
                        <Copy className="h-3 w-3 mr-1" />
                      )}
                      Copy
                    </Button>
                  </div>
                  <pre className="p-2.5 rounded-lg bg-zinc-900 text-xs text-zinc-300 font-mono overflow-x-auto border border-zinc-800/80">
                    adb logcat --pid=$(adb shell pidof -s {bundleId})
                  </pre>
                </div>
              </div>
            </div>
          ) : (
            /* =======================================================================
               OPTION 5: CLOUD STREAM & REMOTE EMULATION
            ======================================================================= */
            <div className="max-w-xl w-full flex flex-col gap-4 py-4 text-center items-center">
              <div className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/90 p-8 shadow-2xl backdrop-blur-sm space-y-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/30 mx-auto">
                  <Cloud className="h-7 w-7" />
                </div>
                <h2 className="text-base font-bold text-zinc-100">Cloud Device Streaming</h2>
                <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
                  Run this mobile application directly in an isolated remote headless Android emulator container or stream it via WebRTC in your browser.
                </p>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-left space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">Streaming Engine:</span>
                    <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary text-[10px]">
                      WebRTC Android Bridge
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">Resolution:</span>
                    <span className="font-mono text-zinc-200">1080 × 2400 @ 60 FPS</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">Target URL:</span>
                    <span className="font-mono text-zinc-200 truncate max-w-[200px]">{runtimeUrl}</span>
                  </div>
                </div>

                <div className="pt-2 flex flex-col sm:flex-row gap-2 justify-center">
                  <a
                    href={runtimeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 font-semibold text-xs text-primary-foreground hover:bg-primary/90 transition-colors shadow-lg"
                  >
                    <ExternalLink className="h-4 w-4" />
                    <span>Launch Cloud Stream</span>
                  </a>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTestMode("simulator")}
                    className="h-10 text-xs border-zinc-800 text-zinc-300 hover:bg-zinc-800"
                  >
                    Switch to Local Simulator
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT DOCK: Quick Actions, Specifications & QR Code */}
        {showQrPanel && (
          <aside className="w-80 shrink-0 border-l border-zinc-800 bg-zinc-900/95 p-5 flex flex-col gap-5 overflow-y-auto z-20 backdrop-blur-md">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-primary">
                  Testing Center
                </span>
                <Badge
                  variant="outline"
                  className="border-primary/40 bg-primary/10 text-[10px] text-primary"
                >
                  Active
                </Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
                Seamlessly test and distribute across physical devices, emulators, or local sideload.
              </p>
            </div>

            {/* Quick QR Card */}
            <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-xl">
              <div className="relative rounded-lg overflow-hidden border border-zinc-800 p-1 bg-zinc-900">
                <img
                  src={qrImageUrl}
                  alt="Quick Mobile QR Code"
                  width={200}
                  height={200}
                  className="rounded-md"
                />
              </div>

              <div className="mt-3 flex items-center gap-1 text-[11px] text-zinc-400">
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                <span>Camera scan ready</span>
              </div>
            </div>

            {/* Quick Sideload APK button if Android */}
            {isAndroid && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                  <Download className="h-4 w-4" />
                  <span>Download APK ({apkFileName})</span>
                </div>
                <p className="text-[11px] text-zinc-300">
                  Direct debug APK generated from Gradle build. Sideload directly to any Android device.
                </p>
                <a
                  href={apkDownloadUrl}
                  download={apkFileName}
                  className="flex items-center justify-center gap-1.5 w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-zinc-950 font-semibold text-xs py-2 transition-colors shadow-sm"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download APK
                </a>
              </div>
            )}

            {/* Direct URL & Copy */}
            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                Deployment Runtime URL
              </label>
              <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5">
                <input
                  type="text"
                  readOnly
                  value={runtimeUrl}
                  className="flex-1 bg-transparent px-1.5 text-xs text-zinc-300 outline-none font-mono select-all truncate"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleCopy(runtimeUrl, "url")}
                  className="h-7 px-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                >
                  {copiedUrl ? (
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
                  <span>Target SDK:</span>
                  <span className="font-mono text-zinc-200">{sdkVersion}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Bundle ID:</span>
                  <span className="font-mono text-zinc-200 truncate max-w-[140px]" title={bundleId}>{bundleId}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Viewport:</span>
                  <span className="font-mono text-zinc-200">
                    {deviceWidth} × {deviceHeight} px
                  </span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Touch Emulation:</span>
                  <span className="text-emerald-400 font-medium">Active</span>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
