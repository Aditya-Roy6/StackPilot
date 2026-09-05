"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  LayoutDashboard,
  Server,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Laptop,
  Activity,
  Star,
  Network,
  Boxes,
  Gauge,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTheme } from "next-themes";
import api from "@/lib/api";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AppIcon } from "@/lib/custom-icons";
import { setUiTheme, UI_THEME_STORAGE_KEY } from "@/lib/ui-theme";

const navigation = [
  { name: "Projects", href: "/dashboard", icon: LayoutDashboard, iconName: "layout-dashboard" },
  { name: "Deployments", href: "/dashboard/deployments", icon: Server, iconName: "server" },
  { name: "Logs & Monitoring", href: "/dashboard/logging-monitoring", icon: Activity, iconName: "activity" },
  { name: "Visualization", href: "/dashboard/logging-monitoring/visualization", icon: Gauge, iconName: "gauge", nested: true },
  { name: "Infrastructure", href: "/dashboard/logging-monitoring/infrastructure", icon: Network, iconName: "network", nested: true },
  { name: "Cluster Builder", href: "/dashboard/logging-monitoring/clusters", icon: Boxes, iconName: "boxes", nested: true },
  { name: "AI Agent", href: "/dashboard/ai", icon: Star, iconName: "star", filled: true },
  { name: "Secrets", href: "/dashboard/secrets", icon: KeyRound, iconName: "key-round" },
  { name: "Organization", href: "/dashboard/organization", icon: Building2, iconName: "building-2" },
  { name: "Settings", href: "/dashboard/settings", icon: Settings, iconName: "settings" },
];

// Routes that own their entire viewport (no shell padding, no page scroll).
const FULL_BLEED_ROUTES = ["/dashboard/ai"];

const themeOptions = [
  { value: "light", label: "Light", icon: Sun, iconName: "sun" },
  { value: "dark", label: "Dark", icon: Moon, iconName: "moon" },
  { value: "system", label: "System", icon: Laptop, iconName: "laptop" },
] as const;

const SIDEBAR_STORAGE_KEY = "sidebar-collapsed";

const subscribeNever = () => () => {};

// localStorage is external state, so it is read through useSyncExternalStore
// rather than mirrored into an effect. This keeps server and client markup in
// agreement during hydration and avoids cascading renders.
const sidebarListeners = new Set<() => void>();

const sidebarStore = {
  subscribe(listener: () => void) {
    sidebarListeners.add(listener);
    return () => {
      sidebarListeners.delete(listener);
    };
  },
  getSnapshot() {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  },
  getServerSnapshot() {
    return false;
  },
  set(collapsed: boolean) {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
    for (const listener of sidebarListeners) listener();
    api.put("/auth/preferences", { sidebar_collapsed: collapsed }).catch(() => {});
  },
};

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const asideRef = useRef<HTMLElement | null>(null);
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);
  const isCollapsed = useSyncExternalStore(
    sidebarStore.subscribe,
    sidebarStore.getSnapshot,
    sidebarStore.getServerSnapshot
  );
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const { theme, setTheme } = useTheme();
  const activeThemeValue = mounted && (theme === "light" || theme === "dark" || theme === "system") ? theme : "system";
  const activeTheme = themeOptions.find((option) => option.value === activeThemeValue) ?? themeOptions[2];
  const ActiveThemeIcon = activeTheme.icon;
  const isFullBleed = FULL_BLEED_ROUTES.includes(pathname);

  // Animate width only after the first paint, so restoring a collapsed sidebar
  // on load appears instant instead of sliding in from the expanded width.
  useEffect(() => {
    const element = asideRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.classList.add("transition-[width]", "duration-200", "ease-out");
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkSession = async () => {
      try {
        const res = await api.get("/auth/me");
        const prefs = res.data?.user?.preferences;
        if (prefs && !cancelled) {
          if (prefs.sidebar_collapsed !== undefined && prefs.sidebar_collapsed !== sidebarStore.getSnapshot()) {
            window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(prefs.sidebar_collapsed));
            for (const listener of sidebarListeners) listener();
          }
          if (prefs.ui_theme) {
            const currentTheme = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
            if (currentTheme !== prefs.ui_theme) {
              setUiTheme(prefs.ui_theme as any);
            }
          }
          if (prefs.color_mode && ["light", "dark", "system"].includes(prefs.color_mode)) {
            if (theme !== prefs.color_mode) {
              setTheme(prefs.color_mode);
            }
          }
        }
      } catch (error: any) {
        if (!cancelled && error.response?.status === 401) {
          window.location.href = "/auth/login";
        }
      }
    };

    checkSession();
    const interval = setInterval(checkSession, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [theme, setTheme]);

  const toggleSidebar = () => {
    sidebarStore.set(!isCollapsed);
  };

  const handleLogout = async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      window.location.href = "/auth/login";
    }
  };

  // The label lives in a collapsing grid column so it slides away instead of
  // popping out of the DOM. Keeping it mounted is what makes the toggle smooth.
  const labelClass = cn(
    "min-w-0 overflow-hidden truncate whitespace-nowrap text-left text-[13px] font-medium transition-opacity duration-150",
    isCollapsed ? "opacity-0" : "opacity-100"
  );

  // Collapsed drops the gap and centers the tracks; otherwise the 8px gap sits
  // entirely to the right of the icon and shifts it off-center in the rail.
  const rowClass = (isCollapsed: boolean) =>
    cn(
      "grid h-9 items-center overflow-hidden rounded-lg transition-[grid-template-columns] duration-200 ease-out",
      isCollapsed ? "grid-cols-[36px_0fr] justify-center gap-0" : "grid-cols-[36px_1fr] gap-2"
    );

  const renderSidebarLink = (item: (typeof navigation)[number], isActive: boolean) => (
    <Link
      key={item.name}
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        rowClass(isCollapsed),
        "relative w-full",
        !isCollapsed && item.nested && "pl-3",
        isActive
          ? "bg-accent font-semibold text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center">
        <AppIcon
          name={item.iconName}
          fallback={item.icon}
          size={18}
          className={cn("h-[18px] w-[18px]", isActive ? "text-primary" : "text-current")}
        />
      </span>
      <span className={labelClass}>{item.name}</span>
    </Link>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside
        ref={asideRef}
        className={cn(
          "z-20 flex h-full shrink-0 flex-col border-r border-border bg-card",
          isCollapsed ? "w-[60px]" : "w-[208px]"
        )}
      >
        <TooltipProvider>
          {/* Brand + toggle share a row, so the control never floats over content. */}
          <div
            className={cn(
              "flex h-14 shrink-0 items-center border-b border-border",
              isCollapsed ? "justify-center px-2" : "justify-between pl-3 pr-2"
            )}
          >
            {!isCollapsed && (
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
                  <AppIcon name="star" size={16} />
                </span>
                <span className="truncate text-sm font-semibold tracking-tight">StackPilot</span>
              </span>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleSidebar}
                    aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    aria-expanded={!isCollapsed}
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    {isCollapsed ? (
                      <AppIcon name="panel-left-open" fallback={PanelLeftOpen} size={18} className="h-[18px] w-[18px]" />
                    ) : (
                      <AppIcon name="panel-left-close" fallback={PanelLeftClose} size={18} className="h-[18px] w-[18px]" />
                    )}
                  </Button>
                }
              />
              <TooltipContent side="right">{isCollapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
            </Tooltip>
          </div>

          <div className={cn("shrink-0 py-1.5", isCollapsed ? "flex justify-center px-1" : "px-2")}>
            <WorkspaceSwitcher isCollapsed={isCollapsed} />
          </div>

          <nav
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden py-3 scrollbar-thin",
              isCollapsed ? "items-center px-2" : "px-2"
            )}
          >
            {navigation.map((item) => {
              const isActive =
                item.name === "Projects"
                  ? pathname === "/dashboard" || pathname.startsWith("/dashboard/projects")
                  : pathname === item.href;
              if (!isCollapsed) {
                return renderSidebarLink(item, isActive);
              }
              return (
                <Tooltip key={item.name}>
                  <TooltipTrigger render={renderSidebarLink(item, isActive)} />
                  <TooltipContent side="right">{item.name}</TooltipContent>
                </Tooltip>
              );
            })}
          </nav>

          <div
            className={cn(
              "flex shrink-0 flex-col gap-0.5 border-t border-border py-3",
              isCollapsed ? "items-center px-2" : "px-2"
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    onClick={() => setThemeDialogOpen(true)}
                    aria-label="Theme"
                    className={cn(
                      rowClass(isCollapsed),
                      "w-full justify-start p-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    )}
                  >
                    <span className="flex h-9 w-9 items-center justify-center">
                      <AppIcon name={activeTheme.iconName} fallback={ActiveThemeIcon} size={18} className="h-[18px] w-[18px]" />
                    </span>
                    <span className={labelClass}>{activeTheme.label}</span>
                  </Button>
                }
              />
              <TooltipContent side="right">{activeTheme.label} theme</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    onClick={handleLogout}
                    aria-label="Logout"
                    className={cn(
                      rowClass(isCollapsed),
                      "w-full justify-start p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    )}
                  >
                    <span className="flex h-9 w-9 items-center justify-center">
                      <AppIcon name="log-out" fallback={LogOut} size={18} className="h-[18px] w-[18px]" />
                    </span>
                    <span className={labelClass}>Logout</span>
                  </Button>
                }
              />
              <TooltipContent side="right">Logout</TooltipContent>
            </Tooltip>
          </div>

          <Dialog open={themeDialogOpen} onOpenChange={setThemeDialogOpen}>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Theme</DialogTitle>
                <DialogDescription>Choose the interface mode for this device.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                {themeOptions.map((option) => {
                  const ThemeIcon = option.icon;
                  const isSelected = activeThemeValue === option.value;

                  return (
                    <Button
                      key={option.value}
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      className="justify-start gap-2"
                      onClick={() => {
                        setTheme(option.value);
                        api.put("/auth/preferences", { color_mode: option.value }).catch(() => {});
                        setThemeDialogOpen(false);
                      }}
                    >
                      <AppIcon name={option.iconName} fallback={ThemeIcon} size={16} className="h-4 w-4 shrink-0" />
                      <span>{option.label}</span>
                    </Button>
                  );
                })}
              </div>
            </DialogContent>
          </Dialog>
        </TooltipProvider>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <main
          className={cn(
            "flex-1 bg-background/50 scrollbar-thin",
            isFullBleed ? "overflow-hidden p-0" : "overflow-y-auto p-5 md:p-8"
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
