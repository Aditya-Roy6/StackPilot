import platform
import socket
import psutil
from typing import Dict, Tuple
from ..ui import console, print_banner, render_table, print_success, print_error, print_warning
from ..services.docker_service import is_docker_installed, is_docker_running, get_docker_version, get_container_status
from ..services.ai_client import AIClient
from ..services.backend_client import BackendClient

def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0

def run_doctor():
    print_banner("System Health & Diagnostic Doctor")
    
    # 1. Hardware & OS
    mem = psutil.virtual_memory()
    mem_total_gb = mem.total / (1024 ** 3)
    mem_avail_gb = mem.available / (1024 ** 3)
    cpu_count = psutil.cpu_count(logical=True)
    os_info = f"{platform.system()} {platform.release()} ({platform.machine()})"

    rows = [
        ["Operating System", os_info, "✅ OK"],
        ["CPU Cores", f"{cpu_count} logical cores", "✅ OK"],
        ["Total RAM", f"{mem_total_gb:.1f} GB ({mem_avail_gb:.1f} GB available)", "✅ OK" if mem_total_gb >= 8 else "⚠️ Low (Potato mode recommended)"]
    ]

    # 2. Docker
    d_installed = is_docker_installed()
    d_running = is_docker_running()
    d_ver = get_docker_version() or "Not found"

    rows.append(["Docker Executable", d_ver, "✅ Installed" if d_installed else "❌ Missing"])
    rows.append(["Docker Daemon", "Active & responsive" if d_running else "Stopped / Unresponsive", "✅ Running" if d_running else "❌ Stopped"])

    # 3. Port Audit
    ports = [
        ("Backend (Drogon)", 8090),
        ("AI Service (FastAPI)", 8010),
        ("Frontend (Next.js)", 3000),
        ("Browser CDP Proxy", 9222),
        ("Browser WebCodecs Stream", 8099),
        ("PostgreSQL Database", 5433),
        ("Redis Queue", 6379)
    ]

    for name, port in ports:
        in_use = is_port_in_use(port)
        status_text = "🟢 Active / In Use" if in_use else "⚪ Free / Inactive"
        rows.append([f"Port {port} ({name})", f"127.0.0.1:{port}", status_text])

    # 4. Service Live Probes
    ai_client = AIClient()
    ai_health = ai_client.check_health()
    if ai_health.get("status") == "ok":
        rows.append(["AI Service API", f"{ai_client.base_url}/health", "🟢 Healthy (200 OK)"])
    else:
        rows.append(["AI Service API", f"{ai_client.base_url}/health", f"⚪ Unreachable ({ai_health.get('error', '')[:25]})"])

    backend_client = BackendClient()
    be_health = backend_client.check_health()
    if be_health.get("status") == "ok":
        rows.append(["C++ Backend API", f"{backend_client.base_url}/api/v1/health", "🟢 Healthy (200 OK)"])
    else:
        rows.append(["C++ Backend API", f"{backend_client.base_url}/api/v1/health", f"⚪ Unreachable ({be_health.get('error', '')[:25]})"])

    render_table("StackPilot Environment Diagnostics", ["Component", "Details", "Status"], rows)

    # 5. Containers summary
    containers = get_container_status()
    if containers:
        c_rows = []
        for c in containers:
            status_style = "🟢" if "Up" in c["status"] else "🔴"
            c_rows.append([c["name"], c["image"], f"{status_style} {c['status']}", c["ports"][:35]])
        render_table("Active StackPilot Containers", ["Container Name", "Image", "Status", "Ports"], c_rows)
    else:
        console.print("[dim]No StackPilot containers are currently running. Use [bold cyan]stackpilot up[/bold cyan] to start them.[/dim]\n")
