# 🚀 StackPilot CLI (`stackpilot`)

**100% Terminal CLI for StackPilot** — Control autonomous browser QA, streaming AI co-pilot chats, Docker service profiles, CI/CD deployments, environments, and Kubernetes clusters without ever opening a web browser.

---

## ⚡ Quick Start

### Windows (PowerShell / CMD)
```cmd
# Run directly from workspace
stackpilot doctor
stackpilot status
```

### Installation via Pip
```bash
cd stackpilot-cli
pip install -e .
```

Now you can invoke `stackpilot` from anywhere in your terminal!

---

## 📖 Command Reference

### 1. System Diagnostics & Setup
| Command | Description |
| :--- | :--- |
| `stackpilot init` | Interactive setup wizard (audits OS/RAM, checks Docker, generates secure `.env` secrets) |
| `stackpilot doctor` | Complete health audit (ports, Docker daemon, memory, CPU, live service probes) |

### 2. Service & Lifecycle Management
| Command | Description |
| :--- | :--- |
| `stackpilot up` | Start StackPilot services with modular profiles |
| `stackpilot up --profile core` | Start **Core QA only** (AI Service + Browser Sandbox + Frontend + DB) [~1.5GB RAM] |
| `stackpilot up --profile full` | Start **Full Platform** (Core + C++ Drogon Backend + Build Engine) |
| `stackpilot up --profile monitoring` | Start **Enterprise Suite** (+ Prometheus, Grafana, Loki) |
| `stackpilot down` | Stop all StackPilot services |
| `stackpilot down --volumes` | Stop all services and wipe persistent volumes |
| `stackpilot status` (or `ps`) | Display live status table of containers, health, and port bindings |
| `stackpilot logs -f [service]` | Stream color-coded logs from any service or all containers |

### 3. AI Co-Pilot & Autonomous Browser Testing
| Command | Description |
| :--- | :--- |
| `stackpilot test <url>` | Run autonomous browser QA against any URL with live action feed |
| `stackpilot test <url> -d 3` | Deep crawl and test subpages up to depth 3 |
| `stackpilot chat` | Interactive full-terminal conversational AI co-pilot with streaming tokens |
| `stackpilot chat -m <model>` | Chat with model override (e.g. `gpt-4o`, `claude-3-5-sonnet`) |

### 4. User Authentication
| Command | Description |
| :--- | :--- |
| `stackpilot auth login` | Authenticate with email/password and store session token |
| `stackpilot auth register` | Create a new user account |
| `stackpilot auth me` | Show currently authenticated user details |
| `stackpilot auth logout` | Clear active authentication session |

### 5. Projects & Environments
| Command | Description |
| :--- | :--- |
| `stackpilot project list` | List all registered projects |
| `stackpilot project create <name> --repo <url>` | Create a new project |
| `stackpilot project delete <id>` | Delete a project |
| `stackpilot env list <project_id>` | List environments, branch mappings, and CI gating |

### 6. CI/CD & Deployments
| Command | Description |
| :--- | :--- |
| `stackpilot deploy trigger <project_id>` | Trigger a new build and deployment |
| `stackpilot deploy list <project_id>` | View past deployments, commit SHAs, and statuses |
| `stackpilot deploy logs <deployment_id>` | Stream deployment and build logs |

### 7. Kubernetes & Clusters
| Command | Description |
| :--- | :--- |
| `stackpilot cluster list` | List managed Kubernetes clusters and node counts |

---

## ⚙️ Configuration
Stored in `~/.stackpilot/config.json`:
```json
{
  "backend_url": "http://localhost:8090",
  "ai_service_url": "http://localhost:8010",
  "browser_stream_url": "http://localhost:8099",
  "frontend_url": "http://localhost:3000",
  "default_profile": "core",
  "timeout_seconds": 60,
  "potato_mode": false
}
```
Authentication token is stored securely in `~/.stackpilot/auth.json`.
