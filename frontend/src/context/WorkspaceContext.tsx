"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  is_personal: boolean;
  role: "owner" | "admin" | "member" | "viewer";
  member_count: number;
  created_at: string;
}

interface WorkspaceContextType {
  organizations: Organization[];
  activeWorkspaceId: string | null;
  activeWorkspace: Organization | null;
  setActiveWorkspaceId: (id: string | null) => void;
  isLoading: boolean;
  refetchOrganizations: () => Promise<unknown>;
}

const WORKSPACE_STORAGE_KEY = "stackpilot_active_workspace_id";

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
      if (saved) {
        setActiveWorkspaceIdState(saved);
      }
    } catch {}
  }, []);

  const { data: organizations = [], isLoading, refetch } = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const res = await api.get<{ organizations: Organization[] }>("/organizations");
      return res.data.organizations || [];
    },
    staleTime: 30000,
  });

  const setActiveWorkspaceId = (id: string | null) => {
    setActiveWorkspaceIdState(id);
    try {
      if (id) {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
      } else {
        localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      }
    } catch {}
  };

  const activeWorkspace = activeWorkspaceId
    ? organizations.find((o) => o.id === activeWorkspaceId) || null
    : null;

  return (
    <WorkspaceContext.Provider
      value={{
        organizations,
        activeWorkspaceId,
        activeWorkspace,
        setActiveWorkspaceId,
        isLoading,
        refetchOrganizations: refetch,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}
