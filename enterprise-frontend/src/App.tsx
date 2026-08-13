import {
  AccountTree,
  Api,
  AutoFixHigh,
  CloudQueue,
  Dashboard,
  Dns,
  Hub,
  Key,
  Lan,
  Logout,
  Memory,
  MonitorHeart,
  PlayArrow,
  RocketLaunch,
  Security,
  Settings,
  Storage,
  Terminal,
} from "@mui/icons-material";
import {
  AppBar,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CssBaseline,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { enterpriseTheme } from "./theme/theme";

type NavKey = "overview" | "projects" | "deployments" | "infrastructure" | "automation" | "settings";

const drawerWidth = 284;

const navItems: Array<{ key: NavKey; label: string; icon: ReactNode; description: string }> = [
  { key: "overview", label: "Operations", icon: <Dashboard />, description: "Fleet health and release posture" },
  { key: "projects", label: "Projects", icon: <Storage />, description: "Source, environments, and ownership" },
  { key: "deployments", label: "Deployments", icon: <RocketLaunch />, description: "Builds, runtimes, and rollbacks" },
  { key: "infrastructure", label: "Infrastructure", icon: <Hub />, description: "Docker, Kubernetes, and remote hosts" },
  { key: "automation", label: "Automation", icon: <AutoFixHigh />, description: "Webhooks, CI gates, and AI actions" },
  { key: "settings", label: "Settings", icon: <Settings />, description: "Security, providers, and access control" },
];

const projectRows = [
  {
    id: 1,
    name: "portfolio-new",
    owner: "AdityaRoy999",
    source: "GitHub",
    production: "main",
    development: "dev",
    status: "Healthy",
    runtime: "Remote Kubernetes",
    updated: "7 Jul, 21:44",
  },
  {
    id: 2,
    name: "dokscp-control-plane",
    owner: "platform",
    source: "Compose",
    production: "release",
    development: "staging",
    status: "Review",
    runtime: "Local Kubernetes",
    updated: "7 Jul, 18:02",
  },
  {
    id: 3,
    name: "navrobotec-demo",
    owner: "robotics",
    source: "GitHub",
    production: "main",
    development: "dev",
    status: "Blocked",
    runtime: "Remote Docker",
    updated: "6 Jul, 23:19",
  },
];

const deploymentRows = [
  {
    id: "dep-98537a2",
    project: "portfolio-new",
    environment: "development",
    branch: "dev",
    commit: "98537a2",
    status: "Running",
    runtime: "https://147.93.98.89.nip.io",
    duration: "1m 42s",
    trigger: "GitHub push",
  },
  {
    id: "dep-52084d2",
    project: "portfolio-new",
    environment: "production",
    branch: "main",
    commit: "52084d2",
    status: "Running",
    runtime: "https://portfolio.147.93.98.89.nip.io",
    duration: "2m 09s",
    trigger: "Manual release",
  },
  {
    id: "dep-failed-14",
    project: "navrobotec-demo",
    environment: "production",
    branch: "main",
    commit: "manual",
    status: "Failed",
    runtime: "-",
    duration: "38s",
    trigger: "Remote build",
  },
];

const resourceRows = [
  { id: 1, kind: "Node", name: "control-plane", namespace: "system", cpu: "34%", memory: "61%", state: "Ready" },
  { id: 2, kind: "Node", name: "pi0", namespace: "edge", cpu: "18%", memory: "42%", state: "Ready" },
  { id: 3, kind: "Node", name: "pi1", namespace: "edge", cpu: "12%", memory: "39%", state: "Ready" },
  { id: 4, kind: "Deployment", name: "dokscp-backend", namespace: "dokscp", cpu: "8%", memory: "22%", state: "Running" },
  { id: 5, kind: "Service", name: "ingress-nginx", namespace: "ingress", cpu: "3%", memory: "11%", state: "Ready" },
];

function StatusChip({ status }: { status: string }) {
  const color = status === "Running" || status === "Healthy" || status === "Ready"
    ? "success"
    : status === "Failed" || status === "Blocked"
      ? "error"
      : "warning";

  return <Chip size="small" color={color} label={status} variant="outlined" />;
}

function MetricCard({
  icon,
  label,
  value,
  helper,
  progress,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  helper: string;
  progress?: number;
}) {
  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Stack direction="row" spacing={1.25} alignItems="center">
              <Box sx={{ color: "primary.main", display: "flex" }}>{icon}</Box>
              <Typography color="text.secondary" fontWeight={700} variant="body2">
                {label}
              </Typography>
            </Stack>
            <Chip label="live" size="small" color="primary" variant="outlined" />
          </Stack>
          <Box>
            <Typography variant="h4">{value}</Typography>
            <Typography color="text.secondary" variant="body2">
              {helper}
            </Typography>
          </Box>
          {typeof progress === "number" ? <LinearProgress value={progress} variant="determinate" /> : null}
        </Stack>
      </CardContent>
    </Card>
  );
}

function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <Stack direction={{ xs: "column", md: "row" }} spacing={2} justifyContent="space-between" alignItems={{ xs: "stretch", md: "center" }}>
      <Box>
        <Typography variant="h4">{title}</Typography>
        <Typography color="text.secondary">{subtitle}</Typography>
      </Box>
      {action}
    </Stack>
  );
}

function OperationsView() {
  return (
    <Stack spacing={3}>
      <SectionHeader
        title="Operations Command Center"
        subtitle="Enterprise deployment control with release health, CI state, and cluster readiness in one place."
        action={
          <Stack direction="row" spacing={1}>
            <Button startIcon={<Terminal />} variant="outlined">Open terminal</Button>
            <Button startIcon={<RocketLaunch />} variant="contained">New release</Button>
          </Stack>
        }
      />
      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)", xl: "repeat(4, 1fr)" },
        }}
      >
        <MetricCard icon={<CloudQueue />} label="Runtime availability" value="99.98%" helper="7 services healthy" progress={96} />
        <MetricCard icon={<RocketLaunch />} label="Deployments today" value="18" helper="2 awaiting review" progress={72} />
        <MetricCard icon={<Security />} label="Policy posture" value="Clean" helper="No blocked permissions" progress={88} />
        <MetricCard icon={<Memory />} label="Cluster pressure" value="42%" helper="CPU normalized across nodes" progress={42} />
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", xl: "1.3fr 0.7fr" }, gap: 2 }}>
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">Release pipeline</Typography>
              {["Source changed", "CI checks passed", "Image built", "Runtime promoted"].map((step, index) => (
                <Stack key={step} direction="row" spacing={2} alignItems="center">
                  <Avatar sx={{ width: 30, height: 30, bgcolor: index < 3 ? "success.main" : "primary.main", fontSize: 14 }}>{index + 1}</Avatar>
                  <Box sx={{ flex: 1 }}>
                    <Typography fontWeight={700}>{step}</Typography>
                    <Typography color="text.secondary" variant="body2">
                      {index < 3 ? "Completed with audit trail" : "Waiting for operator approval"}
                    </Typography>
                  </Box>
                  <StatusChip status={index < 3 ? "Running" : "Review"} />
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">AI operations</Typography>
              <TextField
                fullWidth
                placeholder="Ask Stackpilot to diagnose, build, deploy, or generate YAML"
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <AutoFixHigh />
                    </InputAdornment>
                  ),
                }}
              />
              <Stack direction="row" spacing={1} flexWrap="wrap">
                {["Diagnose failed build", "Generate Dockerfile", "Review YAML", "Explain CI"].map((item) => (
                  <Chip key={item} label={item} clickable />
                ))}
              </Stack>
              <Button variant="contained" startIcon={<PlayArrow />}>Run guarded action</Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Stack>
  );
}

function ProjectsView() {
  const columns: GridColDef[] = [
    { field: "name", headerName: "Project", flex: 1.1, minWidth: 180 },
    { field: "owner", headerName: "Owner", width: 150 },
    { field: "source", headerName: "Source", width: 130 },
    { field: "production", headerName: "Prod branch", width: 130 },
    { field: "development", headerName: "Dev branch", width: 130 },
    { field: "runtime", headerName: "Runtime", flex: 1, minWidth: 180 },
    { field: "status", headerName: "Status", width: 130, renderCell: (params) => <StatusChip status={params.value} /> },
    { field: "updated", headerName: "Updated", width: 140 },
  ];

  return (
    <Stack spacing={3}>
      <SectionHeader
        title="Projects"
        subtitle="Branch environments, deployment modes, ownership, and release controls."
        action={<Button startIcon={<Storage />} variant="contained">Create project</Button>}
      />
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <TextField fullWidth label="Search projects" size="small" />
              <FormControl size="small" sx={{ minWidth: 180 }}>
                <InputLabel>Runtime</InputLabel>
                <Select label="Runtime" defaultValue="all">
                  <MenuItem value="all">All runtimes</MenuItem>
                  <MenuItem value="docker">Docker</MenuItem>
                  <MenuItem value="kubernetes">Kubernetes</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <Box sx={{ height: 430 }}>
              <DataGrid rows={projectRows} columns={columns} disableRowSelectionOnClick />
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

function DeploymentsView() {
  const columns: GridColDef[] = [
    { field: "project", headerName: "Project", minWidth: 170, flex: 1 },
    { field: "environment", headerName: "Environment", width: 150 },
    { field: "branch", headerName: "Branch", width: 120 },
    { field: "commit", headerName: "Commit", width: 120 },
    { field: "status", headerName: "Status", width: 130, renderCell: (params) => <StatusChip status={params.value} /> },
    { field: "trigger", headerName: "Trigger", width: 150 },
    { field: "duration", headerName: "Duration", width: 120 },
    { field: "runtime", headerName: "Runtime URL", minWidth: 260, flex: 1.3 },
  ];

  return (
    <Stack spacing={3}>
      <SectionHeader
        title="Deployments"
        subtitle="Every build and runtime operation with branch, commit, trigger, and rollback context."
        action={<Button startIcon={<RocketLaunch />} variant="contained">Deploy environment</Button>}
      />
      <Card>
        <CardContent>
          <Box sx={{ height: 520 }}>
            <DataGrid rows={deploymentRows} columns={columns} disableRowSelectionOnClick />
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}

function InfrastructureView() {
  const columns: GridColDef[] = [
    { field: "kind", headerName: "Kind", width: 130 },
    { field: "name", headerName: "Name", minWidth: 220, flex: 1 },
    { field: "namespace", headerName: "Namespace", width: 150 },
    { field: "cpu", headerName: "CPU", width: 110 },
    { field: "memory", headerName: "Memory", width: 120 },
    { field: "state", headerName: "State", width: 120, renderCell: (params) => <StatusChip status={params.value} /> },
  ];

  return (
    <Stack spacing={3}>
      <SectionHeader
        title="Infrastructure"
        subtitle="Headlamp-style inventory for local Docker, Kubernetes, remote SSH, Tailscale, and Headscale targets."
        action={
          <Stack direction="row" spacing={1}>
            <Button startIcon={<Lan />} variant="outlined">Add server</Button>
            <Button startIcon={<AccountTree />} variant="contained">Bootstrap cluster</Button>
          </Stack>
        }
      />
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", xl: "0.9fr 1.1fr" }, gap: 2 }}>
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">Cluster topology</Typography>
              <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2, height: 360, p: 2, position: "relative", overflow: "hidden" }}>
                {[
                  { label: "control-plane", x: "42%", y: "18%", color: "primary.main" },
                  { label: "pi0", x: "18%", y: "58%", color: "success.main" },
                  { label: "pi1", x: "35%", y: "70%", color: "success.main" },
                  { label: "pi2", x: "56%", y: "70%", color: "success.main" },
                  { label: "cloud-vps", x: "72%", y: "48%", color: "secondary.main" },
                ].map((node) => (
                  <Box
                    key={node.label}
                    sx={{
                      position: "absolute",
                      left: node.x,
                      top: node.y,
                      transform: "translate(-50%, -50%)",
                      border: 1,
                      borderColor: "divider",
                      bgcolor: "background.paper",
                      px: 2,
                      py: 1,
                      borderRadius: 2,
                      minWidth: 128,
                    }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: node.color }} />
                      <Typography fontWeight={700} variant="body2">{node.label}</Typography>
                    </Stack>
                  </Box>
                ))}
              </Box>
            </Stack>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Box sx={{ height: 360 }}>
              <DataGrid rows={resourceRows} columns={columns} disableRowSelectionOnClick />
            </Box>
          </CardContent>
        </Card>
      </Box>
    </Stack>
  );
}

function AutomationView() {
  return (
    <Stack spacing={3}>
      <SectionHeader
        title="Automation"
        subtitle="Central GitHub App webhooks, CI gating, cleanup policies, and guarded AI workflows."
        action={<Button startIcon={<Api />} variant="contained">Configure GitHub App</Button>}
      />
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "repeat(3, 1fr)" }, gap: 2 }}>
        {[
          ["GitHub App", "Installed on selected repositories", "Healthy"],
          ["CI gate", "Waits for required checks before promotion", "Healthy"],
          ["Cleanup policy", "Retires old runtimes after successful release", "Review"],
        ].map(([title, body, status]) => (
          <Card key={title}>
            <CardContent>
              <Stack spacing={2}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="h6">{title}</Typography>
                  <StatusChip status={status} />
                </Stack>
                <Typography color="text.secondary">{body}</Typography>
                <Divider />
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography color="text.secondary" variant="body2">Enabled</Typography>
                  <Switch defaultChecked />
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Box>
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">Policy preview</Typography>
            <TextField
              multiline
              minRows={8}
              value={`on push to dev:\n  wait_for_ci: false\n  deploy_environment: development\n  cleanup_previous_on_success: true\n\non push to main:\n  wait_for_ci: true\n  deploy_environment: production\n  require_manual_approval: true`}
            />
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

function SettingsView() {
  return (
    <Stack spacing={3}>
      <SectionHeader title="Settings" subtitle="Provider keys, registration mode, remote access, MCP, and security posture." />
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2 }}>
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">Authentication</Typography>
              <FormControl fullWidth size="small">
                <InputLabel>Registration mode</InputLabel>
                <Select label="Registration mode" defaultValue="first-user">
                  <MenuItem value="first-user">First user only</MenuItem>
                  <MenuItem value="invite">Invite code required</MenuItem>
                  <MenuItem value="closed">Closed</MenuItem>
                </Select>
              </FormControl>
              <TextField label="GitHub App slug" value="dokscp" size="small" />
              <TextField label="Webhook URL" value="https://147.93.98.89.nip.io/api/v1/github/webhook" size="small" />
            </Stack>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">Secrets and access</Typography>
              <TextField label="MCP token" type="password" value="••••••••••••••••" size="small" InputProps={{ startAdornment: <InputAdornment position="start"><Key /></InputAdornment> }} />
              <TextField label="Remote default workspace" value="/root/DOKSCP/dokscp-builds" size="small" />
              <Button variant="outlined" startIcon={<Security />}>Run security audit</Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Stack>
  );
}

function Content({ active }: { active: NavKey }) {
  if (active === "projects") return <ProjectsView />;
  if (active === "deployments") return <DeploymentsView />;
  if (active === "infrastructure") return <InfrastructureView />;
  if (active === "automation") return <AutomationView />;
  if (active === "settings") return <SettingsView />;
  return <OperationsView />;
}

export function App() {
  const [active, setActive] = useState<NavKey>("overview");
  const activeItem = useMemo(() => navItems.find((item) => item.key === active) ?? navItems[0], [active]);

  return (
    <ThemeProvider theme={enterpriseTheme}>
      <CssBaseline />
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
        <AppBar position="fixed" elevation={0} sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, borderBottom: 1, borderColor: "divider", bgcolor: "rgba(18,22,27,0.96)" }}>
          <Toolbar sx={{ gap: 2 }}>
            <Box sx={{ width: 34, height: 34, borderRadius: 2, bgcolor: "primary.main", display: "grid", placeItems: "center", fontWeight: 900 }}>S</Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6">Stackpilot Enterprise Console</Typography>
              <Typography color="text.secondary" variant="caption">{activeItem.description}</Typography>
            </Box>
            <TextField size="small" placeholder="Search projects, pods, commits" sx={{ minWidth: 340, display: { xs: "none", lg: "block" } }} />
            <Tooltip title="Cluster telemetry">
              <IconButton>
                <Badge color="success" variant="dot">
                  <MonitorHeart />
                </Badge>
              </IconButton>
            </Tooltip>
            <Avatar sx={{ bgcolor: "primary.main", width: 34, height: 34 }}>AD</Avatar>
          </Toolbar>
        </AppBar>

        <Drawer
          variant="permanent"
          sx={{
            width: drawerWidth,
            flexShrink: 0,
            [`& .MuiDrawer-paper`]: {
              width: drawerWidth,
              boxSizing: "border-box",
              borderRight: 1,
              borderColor: "divider",
              bgcolor: "background.paper",
            },
          }}
        >
          <Toolbar />
          <Box sx={{ p: 2 }}>
            <Typography color="text.secondary" fontWeight={800} variant="overline">Control plane</Typography>
            <List sx={{ mt: 1 }}>
              {navItems.map((item) => (
                <ListItemButton
                  key={item.key}
                  selected={active === item.key}
                  onClick={() => setActive(item.key)}
                  sx={{ borderRadius: 2, mb: 0.5 }}
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.label} secondary={item.description} />
                </ListItemButton>
              ))}
            </List>
          </Box>
          <Box sx={{ flex: 1 }} />
          <Box sx={{ p: 2 }}>
            <Button fullWidth startIcon={<Logout />} variant="outlined">Logout</Button>
          </Box>
        </Drawer>

        <Box component="main" sx={{ ml: `${drawerWidth}px`, pt: 10, px: 3, pb: 4 }}>
          <Tabs value={active} onChange={(_, value) => setActive(value)} sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }} variant="scrollable">
            {navItems.map((item) => (
              <Tab key={item.key} label={item.label} value={item.key} />
            ))}
          </Tabs>
          <Content active={active} />
        </Box>
      </Box>
    </ThemeProvider>
  );
}
