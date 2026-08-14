"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Plus, Shield, UserMinus, Users } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import api from "@/lib/api";

interface Organization {
  id: string;
  name: string;
  slug: string;
  is_personal: boolean;
  role: Role;
  member_count: number;
  created_at: string;
}

interface Member {
  user_id: string;
  username: string;
  email: string;
  full_name: string;
  role: Role;
  joined_at: string;
}

type Role = "owner" | "admin" | "member" | "viewer";

/** Mirrors Authz::roleRank. Kept in the same order so the UI cannot imply a
 *  permission the server will refuse. */
const ROLE_ORDER: Role[] = ["viewer", "member", "admin", "owner"];
const rank = (role: Role) => ROLE_ORDER.indexOf(role);

const ROLE_SUMMARY: Record<Role, string> = {
  owner: "Everything, including deleting the organization",
  admin: "Manage members, delete projects",
  member: "Create and deploy projects, read and write secrets",
  viewer: "Read-only. Cannot reveal secrets or deploy",
};

function errorText(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "response" in error) {
    const detail = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
    if (detail) return detail;
  }
  return fallback;
}

export default function OrganizationPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const res = await api.get<{ organizations: Organization[] }>("/organizations");
      return res.data.organizations || [];
    },
  });

  const organizations = orgsQuery.data || [];
  const active = organizations.find((org) => org.id === selectedId) || organizations[0];

  const membersQuery = useQuery({
    queryKey: ["organization-members", active?.id],
    queryFn: async () => {
      const res = await api.get<{ members: Member[] }>(`/organizations/${active!.id}/members`);
      return res.data.members || [];
    },
    enabled: Boolean(active?.id),
  });

  const createOrg = useMutation({
    mutationFn: async (name: string) => (await api.post("/organizations", { name })).data,
    onSuccess: (data) => {
      toast.success("Organization created");
      setCreateOpen(false);
      setNewName("");
      setSelectedId(data?.organization?.id || "");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (error) => toast.error(errorText(error, "Could not create the organization")),
  });

  const addMember = useMutation({
    mutationFn: async () =>
      (await api.post(`/organizations/${active!.id}/members`, { email: inviteEmail, role: inviteRole })).data,
    onSuccess: () => {
      toast.success("Member added");
      setInviteEmail("");
      queryClient.invalidateQueries({ queryKey: ["organization-members", active?.id] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (error) => toast.error(errorText(error, "Could not add that member")),
  });

  const changeRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role }) =>
      (await api.patch(`/organizations/${active!.id}/members/${userId}`, { role })).data,
    onSuccess: () => {
      toast.success("Role updated");
      queryClient.invalidateQueries({ queryKey: ["organization-members", active?.id] });
    },
    onError: (error) => toast.error(errorText(error, "Could not change that role")),
  });

  const removeMember = useMutation({
    mutationFn: async (userId: string) =>
      (await api.delete(`/organizations/${active!.id}/members/${userId}`)).data,
    onSuccess: () => {
      toast.success("Member removed");
      queryClient.invalidateQueries({ queryKey: ["organization-members", active?.id] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (error) => toast.error(errorText(error, "Could not remove that member")),
  });

  // The server enforces all of this; the UI mirrors it so a button that would
  // be refused is not offered in the first place.
  const canManage = active ? rank(active.role) >= rank("admin") : false;
  const isPersonal = active?.is_personal ?? false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who can see your projects, and what they are allowed to do with them.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New organization
        </Button>
      </div>

      {orgsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading organizations…
        </div>
      ) : organizations.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No organizations found. Every account gets a personal workspace, so this usually means
            the request failed rather than that you have none.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            {organizations.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => setSelectedId(org.id)}
                className={cn(
                  "w-full rounded-xl border p-3 text-left transition-colors",
                  org.id === active?.id
                    ? "border-primary bg-accent/40"
                    : "border-border hover:border-primary/40 hover:bg-accent/20"
                )}
              >
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{org.name}</span>
                  <Badge variant="outline">{org.role}</Badge>
                </div>
                <p className="mt-1 pl-6 text-xs text-muted-foreground">
                  {org.member_count} member{org.member_count === 1 ? "" : "s"}
                  {org.is_personal && " · personal workspace"}
                </p>
              </button>
            ))}
          </div>

          <div className="space-y-6">
            {isPersonal && (
              <Card>
                <CardContent className="flex items-start gap-3 py-4 text-sm text-muted-foreground">
                  <Shield className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>
                    This is your personal workspace. It cannot have other members — create a team
                    organization to share projects.
                  </p>
                </CardContent>
              </Card>
            )}

            {!isPersonal && canManage && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Add a member</CardTitle>
                  <CardDescription>
                    They need an existing StackPilot account. Invites to unregistered addresses are
                    not supported yet.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-56 flex-1 space-y-2">
                      <Label htmlFor="invite-email">Email</Label>
                      <Input
                        id="invite-email"
                        value={inviteEmail}
                        onChange={(event) => setInviteEmail(event.target.value)}
                        placeholder="teammate@example.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="invite-role">Role</Label>
                      <select
                        id="invite-role"
                        value={inviteRole}
                        onChange={(event) => setInviteRole(event.target.value as Role)}
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        {ROLE_ORDER.slice()
                          .reverse()
                          // Cannot grant a role above your own; the server
                          // refuses it, so do not offer it.
                          .filter((role) => rank(role) <= rank(active?.role ?? "viewer"))
                          .map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                      </select>
                    </div>
                    <Button
                      onClick={() => addMember.mutate()}
                      disabled={!inviteEmail.trim() || addMember.isPending}
                    >
                      {addMember.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      Add
                    </Button>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{ROLE_SUMMARY[inviteRole]}</p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4" />
                  Members
                </CardTitle>
                <CardDescription>
                  Roles are ordered viewer &lt; member &lt; admin &lt; owner. Secret reveal requires
                  member, deleting a project requires admin.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {membersQuery.isLoading ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading members…
                  </div>
                ) : (
                  (membersQuery.data || []).map((member) => (
                    <div
                      key={member.user_id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {member.full_name || member.username}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {canManage && !isPersonal ? (
                          <select
                            value={member.role}
                            onChange={(event) =>
                              changeRole.mutate({ userId: member.user_id, role: event.target.value as Role })
                            }
                            // An admin cannot change a role at or above their
                            // own level, so those rows are read-only.
                            disabled={rank(member.role) > rank(active?.role ?? "viewer")}
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
                          >
                            {ROLE_ORDER.slice()
                              .reverse()
                              .filter((role) => rank(role) <= rank(active?.role ?? "viewer"))
                              .map((role) => (
                                <option key={role} value={role}>
                                  {role}
                                </option>
                              ))}
                          </select>
                        ) : (
                          <Badge variant="outline">{member.role}</Badge>
                        )}
                        {canManage && !isPersonal && rank(member.role) < rank(active?.role ?? "viewer") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeMember.mutate(member.user_id)}
                            disabled={removeMember.isPending}
                          >
                            <UserMinus className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New organization</DialogTitle>
            <DialogDescription>
              A shared workspace. You become its owner, and can add members afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Platform team"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createOrg.mutate(newName.trim())}
              disabled={!newName.trim() || createOrg.isPending}
            >
              {createOrg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
