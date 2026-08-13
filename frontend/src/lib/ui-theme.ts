"use client";

import { useSyncExternalStore } from "react";

// The theme *family* is a separate axis from light/dark (which next-themes owns
// via the `class` attribute). It lives on <html data-ui-theme="...">, and the
// CSS in globals.css keys every design token off that attribute.
export const UI_THEMES = [
  "shadcn",
  "apple",
  "material",
  "heroui",
  "geist",
  "catppuccin",
  "dracula",
  "nord",
] as const;
export type UiTheme = (typeof UI_THEMES)[number];

export const DEFAULT_UI_THEME: UiTheme = "shadcn";
export const UI_THEME_STORAGE_KEY = "stackpilot.ui-theme";

export interface UiThemeMeta {
  id: UiTheme;
  name: string;
  description: string;
  /** Swatches for the picker preview: [background, surface, accent]. */
  swatches: [string, string, string];
}

export const UI_THEME_META: UiThemeMeta[] = [
  {
    id: "shadcn",
    name: "Default",
    description: "The stock shadcn look — neutral greys and restrained contrast.",
    swatches: ["#ffffff", "#f4f4f5", "#18181b"],
  },
  {
    id: "apple",
    name: "Apple",
    description: "Generous radii, system typeface and systemBlue accents.",
    swatches: ["#ffffff", "#f5f5f7", "#0071e3"],
  },
  {
    id: "material",
    name: "Material",
    description: "Google-style enterprise UI — Roboto, pill buttons, layered elevation.",
    swatches: ["#ffffff", "#f1f3f4", "#1a73e8"],
  },
  {
    id: "heroui",
    name: "HeroUI",
    description: "Soft off-white canvas, white surfaces and a vivid blue accent.",
    swatches: ["#f7f7f7", "#ffffff", "#3b82f6"],
  },
  {
    id: "geist",
    name: "Geist",
    description: "Vercel-style: maximum contrast, minimal chrome, tight radii.",
    swatches: ["#ffffff", "#fafafa", "#000000"],
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    description: "Pastel Latte and Mocha palettes with gentle contrast.",
    swatches: ["#eff1f5", "#e6e9ef", "#1e66f5"],
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "The classic purple-and-pink dark palette, plus a light Alucard variant.",
    swatches: ["#f8f8f2", "#ececf0", "#6c3fc9"],
  },
  {
    id: "nord",
    name: "Nord",
    description: "Cool arctic palette with muted blues and soft contrast.",
    swatches: ["#eceff4", "#e5e9f0", "#5e81ac"],
  },
];

function isUiTheme(value: string | null): value is UiTheme {
  return value !== null && (UI_THEMES as readonly string[]).includes(value);
}

export function applyUiTheme(theme: UiTheme) {
  document.documentElement.setAttribute("data-ui-theme", theme);
}

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Keep other tabs in sync.
  const onStorage = (event: StorageEvent) => {
    if (event.key === UI_THEME_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): UiTheme {
  try {
    const stored = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
    return isUiTheme(stored) ? stored : DEFAULT_UI_THEME;
  } catch {
    return DEFAULT_UI_THEME;
  }
}

// The server has no localStorage, so it must render the default. Returning a
// stable server snapshot is what keeps hydration from mismatching.
function getServerSnapshot(): UiTheme {
  return DEFAULT_UI_THEME;
}

export function setUiTheme(theme: UiTheme) {
  try {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
  } catch {
    // Private-mode or storage-disabled: still apply for this session.
  }
  applyUiTheme(theme);
  emit();
}

export function useUiTheme(): [UiTheme, (theme: UiTheme) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [theme, setUiTheme];
}

/**
 * Runs before first paint (injected in <head>) so a non-default theme does not
 * flash the default palette on load.
 */
export const UI_THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  UI_THEME_STORAGE_KEY
)});var allowed=${JSON.stringify(UI_THEMES)};document.documentElement.setAttribute('data-ui-theme',allowed.indexOf(t)>-1?t:${JSON.stringify(
  DEFAULT_UI_THEME
)});}catch(e){}})();`;
