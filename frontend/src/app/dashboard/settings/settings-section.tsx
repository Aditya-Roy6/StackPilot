"use client";

import type { ReactNode } from "react";

export interface SettingsSectionMeta {
  id: string;
  title: string;
  /** Extra terms users are likely to type that don't appear in the title. */
  keywords: string[];
}

// Single source of truth: the wrapper looks itself up by id, and the page uses
// the same list to tell whether a search matched anything at all.
export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: "account",
    title: "Account Settings",
    keywords: ["account", "profile", "email", "name", "password", "sign in", "security", "login history", "audit"],
  },
  {
    id: "github",
    title: "GitHub Integration",
    keywords: ["github", "oauth", "repository", "repo", "connect", "git"],
  },
  {
    id: "mcp",
    title: "MCP Integrations",
    keywords: ["mcp", "token", "ide", "cursor", "claude", "codex", "agent", "api key", "scope"],
  },
  {
    id: "remote",
    title: "Remote Connections",
    keywords: ["ssh", "remote", "server", "vps", "tailscale", "headscale", "kubernetes", "cluster", "host", "terminal", "docker"],
  },
  {
    id: "platform",
    title: "Platform Configuration",
    keywords: ["platform", "config", "advanced", "system"],
  },
  {
    id: "appearance",
    title: "Appearance",
    keywords: ["theme", "appearance", "dark", "light", "mode", "colour", "color", "apple", "material", "nord", "look", "font"],
  },
];

export function settingsSectionMatches(meta: SettingsSectionMeta, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [meta.title, ...meta.keywords].join(" ").toLowerCase();
  // Every term must match, so "remote ssh" narrows rather than widens.
  return needle.split(/\s+/).every((term) => haystack.includes(term));
}

export function visibleSettingsSections(query: string): SettingsSectionMeta[] {
  return SETTINGS_SECTIONS.filter((meta) => settingsSectionMatches(meta, query));
}

/**
 * Hides a settings section when it doesn't match the search query.
 *
 * Renders `null` rather than hiding with CSS: several sections mount their own
 * queries, sockets and terminals, and keeping them alive but invisible would
 * leave that work running while filtered out.
 */
export function SettingsSection({
  id,
  query,
  children,
}: {
  id: string;
  query: string;
  children: ReactNode;
}) {
  const meta = SETTINGS_SECTIONS.find((section) => section.id === id);
  if (!meta) return <>{children}</>;
  return settingsSectionMatches(meta, query) ? <>{children}</> : null;
}
