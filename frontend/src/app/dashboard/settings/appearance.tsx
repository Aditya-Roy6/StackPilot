"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Check, Laptop, Moon, Palette, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { UI_THEME_META, useUiTheme, type UiTheme } from "@/lib/ui-theme";

const MODES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
] as const;

// Module-level so the store identity is stable across renders.
const subscribeNever = () => () => {};

export function AppearanceSettings() {
  const [uiTheme, setUiTheme] = useUiTheme();
  const { theme, setTheme } = useTheme();

  // next-themes resolves the active mode only on the client, so the selected
  // state must not be rendered during SSR. useSyncExternalStore gives a
  // hydration-safe "are we on the client yet" flag without a setState effect.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);

  const activeMode = theme === "light" || theme === "dark" || theme === "system" ? theme : "system";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-foreground">
          <Palette className="h-5 w-5 text-primary" />
          <CardTitle>Appearance</CardTitle>
        </div>
        <CardDescription>
          Choose a theme for the whole interface. Colours, corner radius, elevation and typeface all
          change together.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium text-foreground">Theme</h4>
            <p className="text-xs text-muted-foreground">Applies instantly and is remembered on this device.</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {UI_THEME_META.map((meta) => {
              const isActive = mounted && uiTheme === meta.id;
              return (
                <button
                  key={meta.id}
                  type="button"
                  onClick={() => setUiTheme(meta.id as UiTheme)}
                  aria-pressed={isActive}
                  className={cn(
                    "group relative flex flex-col gap-3 rounded-xl border p-3 text-left transition-colors",
                    isActive
                      ? "border-primary bg-accent/40 ring-2 ring-primary/30"
                      : "border-border hover:border-primary/40 hover:bg-accent/20"
                  )}
                >
                  {isActive && (
                    <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}

                  {/* Miniature of the theme's own palette, not the active one. */}
                  <div
                    className="flex h-16 w-full overflow-hidden rounded-lg border border-border"
                    aria-hidden="true"
                  >
                    <span className="w-1/4" style={{ backgroundColor: meta.swatches[1] }} />
                    <span className="relative flex-1" style={{ backgroundColor: meta.swatches[0] }}>
                      <span
                        className="absolute left-2 top-3 h-2 w-10 rounded-full"
                        style={{ backgroundColor: meta.swatches[2] }}
                      />
                      <span
                        className="absolute left-2 top-7 h-1.5 w-14 rounded-full opacity-30"
                        style={{ backgroundColor: meta.swatches[2] }}
                      />
                      <span
                        className="absolute left-2 top-10 h-1.5 w-8 rounded-full opacity-20"
                        style={{ backgroundColor: meta.swatches[2] }}
                      />
                    </span>
                  </div>

                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{meta.name}</div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {meta.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium text-foreground">Mode</h4>
            <p className="text-xs text-muted-foreground">
              Each theme has its own light and dark palette.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {MODES.map((mode) => {
              const Icon = mode.icon;
              const isActive = mounted && activeMode === mode.value;
              return (
                <Button
                  key={mode.value}
                  type="button"
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTheme(mode.value)}
                  aria-pressed={isActive}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {mode.label}
                </Button>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
